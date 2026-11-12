// Staging: turns a downloaded file into a folder laid out exactly as it will
// appear under the game's deploy root. Deployment later links these files in.
// Where each file of an archive goes is decided by layout.ts (per game), by the
// mod's FOMOD installer, or by the user when neither can tell.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GameDef, LayoutChoice, LayoutOption, ModVersion } from '../../shared/types';
import { resolveFiles, type FileState, type FomodChoices, type FomodConfig } from '../../shared/fomod';
import { archiveKind, extractArchive, listArchive, listTree, readEntry, safeRel, unpackTo, withTemp } from './archives';
import { decodeXml, findFomod, parseFomod } from './fomod';
import { isBepInExPack } from './games';
import { hasLayout, planLayout, type LayoutDest, type LayoutPlan } from './layout';
import { t } from '../../shared/i18n';

export { safeRel } from './archives';

export const STAGED_PREFIX = 'staged:';
const MARKER = '.lattice-complete';
/** Staging folders made with the layout rules of 0.4 carry this in their name; older ones are redone when asked. */
export const LAYOUT_TAG = '-l2';
const RISKY = /\.(exe|bat|cmd|ps1|vbs|scr|msi|com|js|jse|wsf|hta)$/i;

/** Thrown when an archive carries a FOMOD installer and no choices were given. */
export class FomodRequired extends Error {
  constructor(public config: FomodConfig) {
    super(t('«{0}»: нужно пройти установщик FOMOD', config.moduleName));
  }
}

/** Thrown when an archive holds several variants, or nothing Lattice recognises, and nobody chose. */
export class LayoutRequired extends Error {
  constructor(
    public reason: 'variants' | 'unknown',
    public options: LayoutOption[],
    public dests: LayoutDest[],
  ) {
    super(reason === 'variants' ? t('В архиве несколько вариантов: нужно выбрать, какой ставить') : t('Lattice не узнал, куда положить файлы этого архива: нужно указать'));
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

/**
 * What a zip for Minecraft really is, told by what is inside it: a shader pack,
 * a resource pack, or an archive that only wraps mod jars (as GitHub releases do).
 */
async function minecraftZip(file: string, v: ModVersion, name: string): Promise<{ folder: string } | { jars: string[] }> {
  const declared = minecraftFolder(v, name);
  if (v.loaders.length || !/\.zip$/i.test(name)) return { folder: declared };
  const names = await listArchive(file).catch(() => [] as string[]);
  if (names.some((n) => /^shaders\//i.test(n))) return { folder: 'shaderpacks' };
  if (names.some((n) => /^pack\.mcmeta$/i.test(n))) return { folder: names.some((n) => /^assets\//i.test(n)) || !names.some((n) => /^data\//i.test(n)) ? 'resourcepacks' : 'datapacks' };
  const jars = names.filter((n) => /\.jar$/i.test(n) && !/(^|\/)(sources?|dev|api)[^/]*\.jar$|-(sources|dev|javadoc)\.jar$/i.test(n));
  return jars.length ? { jars } : { folder: declared };
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

/** One name for every way a mod can be installed: its FOMOD answers and its archive layout. */
export function choicesHash(choices?: FomodChoices, layout?: LayoutChoice): string {
  if (!choices && !layout) return '';
  return createHash('sha1')
    .update(JSON.stringify(layout ? { choices, layout } : choices))
    .digest('hex')
    .slice(0, 8);
}

/** Entry names of an archive, as safe relative paths. */
async function archiveNames(file: string): Promise<string[]> {
  return (await listArchive(file)).map((n) => safeRel(n)).filter((n): n is string => !!n);
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

/** Thunderstore packages follow r2modman's rules; every other archive goes through the layout rules. */
function usesLayout(def: GameDef, version: ModVersion): boolean {
  return hasLayout(def) && !(def.kind === 'bepinex' && version.ref.source === 'thunderstore');
}

/** How Lattice would lay out an archive (or a single loose file) for a game, without unpacking it. */
export async function inspectLayout(def: GameDef, version: ModVersion, file: string, modName: string, choice?: LayoutChoice): Promise<LayoutPlan | null> {
  if (def.kind === 'minecraft' || !usesLayout(def, version)) return null;
  const st = await fs.stat(file).catch(() => null);
  if (!st?.isFile()) return null;
  const name = version.files[0]?.filename ?? path.basename(file);
  if (!archiveKind(name)) return planLayout(def, [name], modName, choice);
  const names = await archiveNames(file);
  if (def.kind === 'generic' && findFomod(names)) return null; // its installer decides
  return planLayout(def, names, modName, choice);
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
      const prefix = src ? `${src}/` : '';
      for (const t of tree) {
        if (!t.toLowerCase().startsWith(prefix)) continue;
        // the installer's own folder is never part of what it installs
        if (!prefix && /^fomod\//i.test(t)) continue;
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
  /** the layout the user chose, when the archive needed a choice */
  layout?: LayoutChoice;
  /** what was done to put the files where the game reads them */
  notes: string[];
  /** variants of the archive that were left out */
  extras: number;
}

export interface StageOptions {
  choices?: FomodChoices;
  fileState?: FileState;
  /** the user's answer for an archive with variants or an unknown layout */
  layout?: LayoutChoice;
  /** a name for folders the mod needs for itself (its title) */
  modName?: string;
  /** nobody can be asked: an archive that needs a choice takes the suggested one */
  unattended?: boolean;
}

/**
 * Builds the staged folder for one mod version from its downloaded files
 * (aligned with `version.files`). Reuses an existing complete staging.
 */
export async function stageVersion(def: GameDef, version: ModVersion, downloaded: string[], stagingRoot: string, opts: StageOptions = {}): Promise<StageResult> {
  const first = version.files[0];
  if (first?.url.startsWith(STAGED_PREFIX)) {
    const p = first.url.slice(STAGED_PREFIX.length);
    return { stagedPath: p, warnings: [], fileCount: (await walk(p)).length, notes: [], extras: 0 };
  }
  const key = `${version.ref.source}_${version.ref.projectId}`;
  const variant = choicesHash(opts.choices, opts.layout);
  const laid = usesLayout(def, version);
  const dir = path.join(stagingRoot, safeName(key), safeName(version.versionId) + (laid ? LAYOUT_TAG : '') + (variant ? `-${variant}` : ''));
  const modName = opts.modName || version.name || first?.filename || version.ref.projectId;
  const warnings: string[] = [];
  const notes: string[] = [];
  let extras = 0;
  let fileCount = 0;
  let usedChoices: FomodChoices | undefined;

  const done = await fs.readFile(path.join(dir, MARKER), 'utf8').catch(() => null);
  if (done !== null) {
    // what was noted when the folder was made comes back with it
    let saved: { notes?: string[]; extras?: number } = {};
    try {
      saved = JSON.parse(done) as typeof saved;
    } catch {
      /* a marker of an older version: just a date */
    }
    return { stagedPath: dir, warnings: [], fileCount: (await walk(dir)).length, choices: opts.choices, layout: opts.layout, notes: saved.notes ?? [], extras: saved.extras ?? 0 };
  }
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const fail = async (e: Error): Promise<never> => {
    await fs.rm(dir, { recursive: true, force: true });
    throw e;
  };
  const putFile = async (file: string, rel: string) => {
    // names come from sources and archives: one that points outside the folder is not followed
    const safe = safeRel(rel) ?? safeName(path.basename(rel));
    await fs.mkdir(path.dirname(path.join(dir, safe)), { recursive: true });
    await fs.copyFile(file, path.join(dir, safe));
    fileCount++;
  };
  /** Runs the layout rules; an archive that needs an answer nobody gave stops the staging. */
  const layoutFor = async (names: string[]): Promise<LayoutPlan> => {
    const plan = planLayout(def, names, modName, opts.layout);
    if (plan.ask && !opts.layout) {
      if (!opts.unattended) await fail(new LayoutRequired(plan.ask.reason, plan.ask.options, plan.ask.dests));
      warnings.push(
        plan.ask.reason === 'variants'
          ? t('в архиве несколько вариантов — поставлен «{0}». Другой можно выбрать в карточке мода.', plan.ask.options.filter((o) => o.suggested).map((o) => o.path.replace(/\/$/, '')).join(', '))
          : t('Lattice не узнал структуру архива и положил файлы как есть. Проверьте в карточке мода, куда они попали.'),
      );
    }
    notes.push(...plan.notes);
    extras += plan.extras.length + (plan.ask?.reason === 'variants' ? plan.ask.options.filter((o) => !o.suggested).length : 0);
    return plan;
  };

  for (let i = 0; i < downloaded.length; i++) {
    const file = downloaded[i];
    const name = version.files[i]?.filename ?? path.basename(file);
    const st = await fs.stat(file);
    if (st.isDirectory()) {
      // a folder from another manager may sit under a subfolder of the deploy root (targetPath)
      const sub = version.files[i]?.targetPath ? safeRel(version.files[i].targetPath!) : null;
      await fs.cp(file, sub ? path.join(dir, sub) : dir, { recursive: true });
      fileCount += (await walk(file)).length;
      continue;
    }
    if (def.kind === 'minecraft') {
      const declared = version.files[i]?.targetPath ? safeRel(version.files[i].targetPath!) : null;
      if (declared) {
        await putFile(file, declared);
        continue;
      }
      const kind = await minecraftZip(file, version, name);
      if ('jars' in kind) {
        // a zip that only wraps the mod: its jars go to mods/
        const want = new Set(kind.jars);
        fileCount += await extractArchive(file, dir, (n) => (want.has(n) ? `mods/${path.posix.basename(n)}` : null));
        notes.push(t('Из архива взяты файлы модов (.jar): {0}', kind.jars.map((j) => path.posix.basename(j)).join(', ')));
      } else await putFile(file, `${kind.folder}/${name}`);
      continue;
    }
    if (!archiveKind(name)) {
      // one loose file: the same rules say where it belongs
      if (laid) {
        const plan = await layoutFor([name]);
        await putFile(file, plan.map.get(name) ?? name);
      } else await putFile(file, def.kind === 'bepinex' ? path.posix.join('BepInEx', 'plugins', safeName(version.ref.projectId), name) : name);
      continue;
    }
    const names = await archiveNames(file);
    for (const n of names) if (RISKY.test(n)) warnings.push(t('В архиве есть исполняемый файл: {0}', n));

    const fomod = def.kind === 'generic' ? findFomod(names) : null;
    if (fomod) {
      const buf = await readEntry(file, fomod.entry);
      const config = parseFomod(decodeXml(buf ?? Buffer.alloc(0)), fomod.root);
      if (!opts.choices) await fail(new FomodRequired(config));
      usedChoices = opts.choices;
      fileCount += await withTemp(async (tmp) => {
        await unpackTo(file, tmp);
        return copyFomodFiles(config, opts.choices!, tmp, dir, opts.fileState);
      });
      continue;
    }
    if (!laid) {
      fileCount += await extractArchive(file, dir, bepinexMapper(version.ref.projectId, names, isBepInExPack(version.ref.projectId)));
      continue;
    }
    const plan = await layoutFor(names);
    fileCount += await extractArchive(file, dir, (n) => plan.map.get(n) ?? null);
  }
  if (fileCount === 0) await fail(new Error(t('В архиве не нашлось файлов для установки')));
  await fs.writeFile(path.join(dir, MARKER), JSON.stringify({ at: new Date().toISOString(), notes, extras }));
  return { stagedPath: dir, warnings, fileCount, choices: usedChoices, layout: opts.layout, notes, extras };
}

/** Relative paths (posix) of all regular files under `root`, excluding our marker. */
export async function walk(root: string): Promise<string[]> {
  return (await listTree(root)).filter((r) => r !== MARKER);
}
