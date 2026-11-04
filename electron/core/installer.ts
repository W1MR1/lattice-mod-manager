// Staging: turns a downloaded file into a folder laid out exactly as it will
// appear under the game's deploy root. Deployment later links these files in.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GameDef, ModVersion } from '../../shared/types';
import { resolveFiles, type FileState, type FomodChoices, type FomodConfig } from '../../shared/fomod';
import { archiveKind, extractArchive, listArchive, listTree, readEntry, safeRel, unpackTo, withTemp } from './archives';
import { decodeXml, findFomod, parseFomod } from './fomod';

export { safeRel } from './archives';

export const STAGED_PREFIX = 'staged:';
const MARKER = '.lattice-complete';
const RISKY = /\.(exe|bat|cmd|ps1|vbs|scr|msi|com|js|jse|wsf|hta)$/i;
const DATA_DIRS = new Set([
  'meshes', 'textures', 'scripts', 'interface', 'skse', 'f4se', 'sound', 'music', 'strings', 'seq', 'materials',
  'archive', 'r6', 'bin', 'red4ext', 'engine', 'mods', 'plugins', 'data', 'bepinex',
]);

/** Thrown when an archive carries a FOMOD installer and no choices were given. */
export class FomodRequired extends Error {
  constructor(public config: FomodConfig) {
    super(`«${config.moduleName}»: нужно пройти установщик FOMOD`);
  }
}

export function safeName(s: string): string {
  return s.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').slice(0, 120);
}

function minecraftFolder(v: ModVersion, filename: string): string {
  const mod = v.loaders.some((l) => ['fabric', 'forge', 'neoforge', 'quilt', 'liteloader', 'rift', 'modloader'].includes(l));
  if (mod || /\.jar$/i.test(filename)) return 'mods';
  if (v.loaders.some((l) => ['iris', 'optifine', 'canvas', 'vanilla'].includes(l))) return 'shaderpacks';
  if (v.loaders.includes('datapack')) return 'datapacks';
  return 'resourcepacks';
}

/** r2modman-compatible layout for Thunderstore packages. */
export function bepinexMapper(pkg: string, names: string[], isPack: boolean): (n: string) => string | null {
  if (isPack) {
    // BepInExPack ships the loader inside a folder next to winhttp.dll.
    const marker = names.find((n) => /(^|\/)(winhttp\.dll|doorstop_config\.ini)$/i.test(n));
    const base = marker ? marker.slice(0, marker.lastIndexOf('/') + 1) : '';
    return (n) => (n.startsWith(base) && n.length > base.length ? n.slice(base.length) : null);
  }
  const sub = (kind: string, rest: string) => {
    switch (kind) {
      case 'plugins':
        return `BepInEx/plugins/${pkg}/${rest}`;
      case 'patchers':
        return `BepInEx/patchers/${pkg}/${rest}`;
      case 'core':
        return `BepInEx/core/${pkg}/${rest}`;
      case 'monomod':
        return `BepInEx/monomod/${pkg}/${rest}`;
      case 'config':
        return `BepInEx/config/${rest}`;
      default:
        return null;
    }
  };
  return (n) => {
    const parts = n.split('/');
    const top = parts[0].toLowerCase();
    if (top === 'bepinex' && parts.length > 2) {
      const mapped = sub(parts[1].toLowerCase(), parts.slice(2).join('/'));
      return mapped ?? `BepInEx/${parts.slice(1).join('/')}`;
    }
    if (parts.length > 1) {
      const mapped = sub(top, parts.slice(1).join('/'));
      if (mapped) return mapped;
    }
    return `BepInEx/plugins/${pkg}/${n}`;
  };
}

export function genericMapper(def: GameDef, names: string[]): (n: string) => string | null {
  const tops = new Set(names.map((n) => n.split('/')[0]));
  const single = tops.size === 1 ? [...tops][0] : null;
  const allNested = single !== null && names.every((n) => n.startsWith(`${single}/`));
  let strip = '';
  if (single && allNested) {
    const low = single.toLowerCase();
    if (def.deployDir && low === def.deployDir.toLowerCase()) strip = `${single}/`;
    else if (def.stripSingleRoot && !DATA_DIRS.has(low)) strip = `${single}/`;
  }
  return (n) => (strip ? (n.startsWith(strip) ? n.slice(strip.length) : null) : n);
}

export function choicesHash(choices?: FomodChoices): string {
  return choices ? createHash('sha1').update(JSON.stringify(choices)).digest('hex').slice(0, 8) : '';
}

/** Reads the FOMOD installer of an archive, or null when it has none. */
export async function inspectFomod(file: string): Promise<FomodConfig | null> {
  if (!archiveKind(file)) return null;
  const names = (await listArchive(file)).map((n) => n.replace(/\\/g, '/'));
  const found = findFomod(names);
  if (!found) return null;
  const buf = await readEntry(file, found.entry);
  if (!buf) return null;
  return parseFomod(decodeXml(buf), found.root);
}

/** Case-insensitive lookup of a path inside an unpacked tree (FOMOD authors mix case freely). */
function resolveIn(tree: string[], rel: string): string | null {
  const want = rel.replace(/\/+$/, '').toLowerCase();
  return tree.find((t) => t.toLowerCase() === want) ?? null;
}

async function copyFomodFiles(config: FomodConfig, choices: FomodChoices, unpacked: string, dir: string, fileState?: FileState): Promise<number> {
  const tree = await listTree(unpacked);
  const base = config.root.toLowerCase();
  let count = 0;
  for (const ref of resolveFiles(config, choices, fileState)) {
    const src = `${base}${ref.source}`.replace(/\/+$/, '').toLowerCase();
    const destBase = safeRel(ref.destination) ?? '';
    if (ref.folder) {
      const prefix = `${src}/`;
      for (const t of tree) {
        if (!t.toLowerCase().startsWith(prefix)) continue;
        const rel = safeRel(`${destBase ? `${destBase}/` : ''}${t.slice(prefix.length)}`);
        if (!rel) continue;
        await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
        await fs.copyFile(path.join(unpacked, t), path.join(dir, rel));
        count++;
      }
    } else {
      const hit = resolveIn(tree, src);
      if (!hit) continue;
      const rel = safeRel(destBase && !ref.destination.endsWith('/') ? destBase : `${destBase ? `${destBase}/` : ''}${path.posix.basename(hit)}`);
      if (!rel) continue;
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.copyFile(path.join(unpacked, hit), path.join(dir, rel));
      count++;
    }
  }
  return count;
}

export interface StageResult {
  stagedPath: string;
  warnings: string[];
  fileCount: number;
  /** choices actually used when the archive had a FOMOD installer */
  choices?: FomodChoices;
}

export interface StageOptions {
  choices?: FomodChoices;
  fileState?: FileState;
}

/**
 * Builds the staged folder for one mod version from its downloaded files
 * (aligned with `version.files`). Reuses an existing complete staging.
 */
export async function stageVersion(def: GameDef, version: ModVersion, downloaded: string[], stagingRoot: string, opts: StageOptions = {}): Promise<StageResult> {
  const first = version.files[0];
  if (first?.url.startsWith(STAGED_PREFIX)) {
    const p = first.url.slice(STAGED_PREFIX.length);
    return { stagedPath: p, warnings: [], fileCount: (await walk(p)).length };
  }
  const key = `${version.ref.source}_${version.ref.projectId}`;
  const variant = choicesHash(opts.choices);
  const dir = path.join(stagingRoot, safeName(key), safeName(version.versionId) + (variant ? `-${variant}` : ''));
  try {
    await fs.access(path.join(dir, MARKER));
    return { stagedPath: dir, warnings: [], fileCount: (await walk(dir)).length, choices: opts.choices };
  } catch {
    /* stage fresh */
  }
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const warnings: string[] = [];
  let fileCount = 0;
  let usedChoices: FomodChoices | undefined;

  for (let i = 0; i < downloaded.length; i++) {
    const file = downloaded[i];
    const name = version.files[i]?.filename ?? path.basename(file);
    const st = await fs.stat(file);
    if (st.isDirectory()) {
      await fs.cp(file, dir, { recursive: true });
      fileCount += (await walk(file)).length;
      continue;
    }
    if (def.kind === 'minecraft') {
      const declared = version.files[i]?.targetPath ? safeRel(version.files[i].targetPath!) : null;
      const rel = declared ?? `${minecraftFolder(version, name)}/${name}`;
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.copyFile(file, path.join(dir, rel));
      fileCount++;
      continue;
    }
    if (!archiveKind(name)) {
      const target = def.kind === 'bepinex' ? path.join(dir, 'BepInEx', 'plugins', safeName(version.ref.projectId), name) : path.join(dir, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(file, target);
      fileCount++;
      continue;
    }
    const names = (await listArchive(file)).map((n) => n.replace(/\\/g, '/'));
    for (const n of names) if (RISKY.test(n)) warnings.push(`В архиве есть исполняемый файл: ${n}`);

    const fomod = def.kind === 'generic' ? findFomod(names) : null;
    if (fomod) {
      const buf = await readEntry(file, fomod.entry);
      const config = parseFomod(decodeXml(buf ?? Buffer.alloc(0)), fomod.root);
      if (!opts.choices) {
        await fs.rm(dir, { recursive: true, force: true });
        throw new FomodRequired(config);
      }
      usedChoices = opts.choices;
      fileCount += await withTemp(async (tmp) => {
        await unpackTo(file, tmp);
        return copyFomodFiles(config, opts.choices!, tmp, dir, opts.fileState);
      });
      continue;
    }
    const map =
      def.kind === 'bepinex'
        ? bepinexMapper(version.ref.projectId, names, /bepinexpack/i.test(version.ref.projectId))
        : genericMapper(def, names);
    fileCount += await extractArchive(file, dir, map);
  }
  if (fileCount === 0) throw new Error('В архиве не нашлось файлов для установки');
  await fs.writeFile(path.join(dir, MARKER), new Date().toISOString());
  return { stagedPath: dir, warnings, fileCount, choices: usedChoices };
}

/** Relative paths (posix) of all regular files under `root`, excluding our marker. */
export async function walk(root: string): Promise<string[]> {
  return (await listTree(root)).filter((r) => r !== MARKER);
}
