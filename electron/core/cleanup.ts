// Removal without traces: besides the deployed files (the deployer takes those),
// a mod leaves its staged copies, its cached downloads and the settings files it
// wrote into the game folder while running. Everything found here is offered to
// the user for confirmation; nothing is deleted on a guess.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GameDef, InstalledMod, ModFile } from '../../shared/types';
import { listArchive, readEntry } from './archives';
import { safeName, walk } from './installer';
import { t } from '../../shared/i18n';

export interface Leftover {
  path: string;
  size: number;
  kind: 'staging' | 'download' | 'config' | 'foreign';
  owner: string;
  ownerTitle: string;
  note: string;
  /** preselected in the confirmation list */
  checked: boolean;
}

async function sizeOf(p: string): Promise<number> {
  const st = await fs.stat(p).catch(() => null);
  if (!st) return 0;
  if (st.isFile()) return st.size;
  let total = 0;
  for (const rel of await walk(p)) total += (await fs.stat(path.join(p, rel)).catch(() => null))?.size ?? 0;
  return total;
}

const GENERIC_IDS = new Set(['minecraft', 'java', 'fabricloader', 'quilt_loader', 'forge', 'neoforge', 'mod', 'mods', 'config', 'common', 'core', 'lib', 'api']);

/** Mod ids a Minecraft jar declares (Fabric, Quilt, Forge, NeoForge). */
export async function minecraftModIds(jar: string): Promise<string[]> {
  const names = await listArchive(jar).catch(() => [] as string[]);
  const ids = new Set<string>();
  const read = async (n: string) => (names.includes(n) ? ((await readEntry(jar, n).catch(() => null))?.toString('utf8') ?? '') : '');
  const fabric = await read('fabric.mod.json');
  if (fabric) {
    try {
      const id = (JSON.parse(fabric) as { id?: string }).id;
      if (id) ids.add(id);
    } catch {
      /* not json */
    }
  }
  const quilt = await read('quilt.mod.json');
  if (quilt) {
    try {
      const id = (JSON.parse(quilt) as { quilt_loader?: { id?: string } }).quilt_loader?.id;
      if (id) ids.add(id);
    } catch {
      /* not json */
    }
  }
  for (const toml of ['META-INF/mods.toml', 'META-INF/neoforge.mods.toml']) {
    for (const m of (await read(toml)).matchAll(/modId\s*=\s*"([^"]+)"/g)) ids.add(m[1]);
  }
  return [...ids].filter((id) => id.length >= 3 && !GENERIC_IDS.has(id.toLowerCase()));
}

/** Files and folders in `dir` that belong to `id`: "sodium.json", "sodium-options.json", "sodium/". */
async function matchByName(dir: string, id: string): Promise<string[]> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const low = id.toLowerCase();
  return entries
    .filter((e) => {
      const n = e.toLowerCase();
      const stem = n.replace(/\.[^.]+$/, '');
      return stem === low || n.startsWith(`${low}-`) || n.startsWith(`${low}_`) || n.startsWith(`${low}.`);
    })
    .map((e) => path.join(dir, e));
}

export interface ScanOptions {
  mods: InstalledMod[];
  def: GameDef;
  installPath: string;
  stagingRoot: string;
  cachePathOf: (f: ModFile) => string;
  /** staged folders and cached files still used by any profile or snapshot-free mod */
  inUse: Set<string>;
  /** files Lattice placed in the game folder (lower-case relative paths); anything else in the mod folders is listed, unticked */
  owned?: Set<string>;
}

/** Folders (relative to the deploy root) that hold mods and nothing of the game itself. */
const MOD_DIRS: Record<string, string[]> = {
  minecraft: ['mods'],
  'lethal-company': ['BepInEx/plugins'],
  valheim: ['BepInEx/plugins'],
  riskofrain2: ['BepInEx/plugins'],
  'content-warning': ['BepInEx/plugins'],
  cyberpunk2077: ['archive/pc/mod', 'r6/scripts', 'r6/tweaks', 'red4ext/plugins', 'bin/x64/plugins/cyber_engine_tweaks/mods'],
  stardewvalley: [''],
};

/** Parts of a mod loader that live among the mods without being mods. */
const LOADER_PARTS = new Set(['consolecommands', 'savebackup', 'errorhandler']);

const normRel = (rel: string) => (process.platform === 'win32' ? rel.toLowerCase() : rel);

export async function scanLeftovers(o: ScanOptions): Promise<Leftover[]> {
  const out: Leftover[] = [];
  const seen = new Set<string>();
  const add = async (l: Omit<Leftover, 'size'>) => {
    const k = path.resolve(l.path).toLowerCase();
    if (seen.has(k) || o.inUse.has(k)) return;
    const size = await sizeOf(l.path);
    if (size === 0 && !(await fs.stat(l.path).catch(() => null))) return;
    seen.add(k);
    out.push({ ...l, size });
  };

  for (const m of o.mods) {
    // staged copies of every version of this mod for this game
    const modDir = path.join(o.stagingRoot, safeName(`${m.ref.source}_${m.ref.projectId}`));
    for (const v of await fs.readdir(modDir).catch(() => [] as string[])) {
      await add({ path: path.join(modDir, v), kind: 'staging', owner: m.key, ownerTitle: m.title, note: t('подготовленная копия мода'), checked: true });
    }
    // cached downloads
    for (const f of m.files) {
      if (!/^https?:|^nexus:/.test(f.url)) continue;
      await add({ path: path.dirname(o.cachePathOf(f)), kind: 'download', owner: m.key, ownerTitle: m.title, note: t('скачанный архив'), checked: true });
    }
    // settings the mod wrote into the game folder while running
    if (o.def.kind === 'minecraft') {
      const jars = (await walk(m.stagedPath).catch(() => [] as string[])).filter((r) => /^mods\/[^/]+\.jar$/i.test(r));
      for (const jar of jars) {
        for (const id of await minecraftModIds(path.join(m.stagedPath, jar))) {
          for (const p of await matchByName(path.join(o.installPath, 'config'), id)) {
            await add({ path: p, kind: 'config', owner: m.key, ownerTitle: m.title, note: t('настройки мода ({0})', id), checked: true });
          }
        }
      }
    } else if (o.def.kind === 'bepinex') {
      const name = m.ref.projectId.split('-').slice(1).join('-').replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (name.length >= 4) {
        const cfgDir = path.join(o.installPath, 'BepInEx', 'config');
        for (const e of await fs.readdir(cfgDir).catch(() => [] as string[])) {
          if (e.replace(/[^a-z0-9]/gi, '').toLowerCase().includes(name)) {
            await add({ path: path.join(cfgDir, e), kind: 'config', owner: m.key, ownerTitle: m.title, note: t('настройки плагина (совпадение по имени)'), checked: true });
          }
        }
      }
    }
  }

  // mods that are in the game's mod folders but did not come from Lattice
  if (o.owned) {
    const root = path.join(o.installPath, o.def.deployDir);
    const owned = [...o.owned];
    for (const dir of MOD_DIRS[o.def.id] ?? []) {
      for (const e of await fs.readdir(path.join(root, dir)).catch(() => [] as string[])) {
        const rel = normRel(dir ? `${dir}/${e}` : e);
        if (o.owned.has(rel) || owned.some((x) => x.startsWith(`${rel}/`)) || LOADER_PARTS.has(e.toLowerCase())) continue;
        await add({ path: path.join(root, dir, e), kind: 'foreign', owner: '', ownerTitle: e, note: t('не от Lattice: положен вручную или другой программой'), checked: false });
      }
    }
  }
  return out;
}
