// Deployment: links staged files into the game folder in load order (later
// mods win). A manifest records every file we own; game files we overwrite are
// backed up and restored on purge, so the game folder can always be returned
// to its original state.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DeployResult, InstalledMod } from '../../shared/types';
import type { FileOverlap } from './compat';
import { walk } from './installer';

interface Owned {
  rel: string;
  owner: string;
  staged: string;
  method: 'hardlink' | 'copy';
}

interface Manifest {
  root: string;
  files: Record<string, Owned>;
  backups: string[];
  createdDirs: string[];
  deployedAt: string;
}

const norm = (rel: string) => (process.platform === 'win32' ? rel.toLowerCase() : rel);
const fileCache = new Map<string, string[]>();

export async function stagedFiles(dir: string): Promise<string[]> {
  let list = fileCache.get(dir);
  if (!list) {
    list = await walk(dir);
    fileCache.set(dir, list);
  }
  return list;
}

export function forgetStaged(dir: string) {
  fileCache.delete(dir);
}

async function readManifest(file: string, root: string): Promise<Manifest> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Manifest;
  } catch {
    return { root, files: {}, backups: [], createdDirs: [], deployedAt: '' };
  }
}

async function exists(p: string) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function computeOverlaps(order: string[], mods: Record<string, InstalledMod>): Promise<FileOverlap[]> {
  const owners = new Map<string, { path: string; keys: string[] }>();
  for (const key of order) {
    const m = mods[key];
    if (!m?.enabled || !m.stagedPath) continue;
    for (const rel of await stagedFiles(m.stagedPath)) {
      if (/^BepInEx\/config\//i.test(rel)) continue; // configs are expected to be shared
      const k = norm(rel);
      const o = owners.get(k);
      if (o) o.keys.push(key);
      else owners.set(k, { path: rel, keys: [key] });
    }
  }
  return [...owners.values()].filter((o) => o.keys.length > 1);
}

export interface DeployOptions {
  root: string;
  order: string[];
  mods: Record<string, InstalledMod>;
  manifestPath: string;
  backupDir: string;
  method: 'hardlink' | 'copy';
}

export interface DeployFailure {
  rel: string;
  error: string;
}

const failure = (rel: string, e: unknown): DeployFailure => ({ rel, error: (e as NodeJS.ErrnoException).code ?? (e as Error).message });

/** Files the profile wants in the game folder: later mods in the order win. */
async function wantedFiles(o: Pick<DeployOptions, 'order' | 'mods' | 'method'>) {
  const want = new Map<string, Owned>();
  const contenders = new Map<string, string[]>();
  for (const key of o.order) {
    const m = o.mods[key];
    if (!m?.enabled || !m.stagedPath) continue;
    for (const rel of await stagedFiles(m.stagedPath)) {
      const k = norm(rel);
      contenders.set(k, [...(contenders.get(k) ?? []), key]);
      want.set(k, { rel, owner: key, staged: path.join(m.stagedPath, rel), method: o.method });
    }
  }
  return { want, contenders };
}

/** The manifest for this folder; one written for another folder (the game moved) owns nothing here. */
async function manifestFor(file: string, root: string): Promise<Manifest> {
  const man = await readManifest(file, root);
  if (norm(path.resolve(man.root || root)) !== norm(path.resolve(root))) return { root, files: {}, backups: [], createdDirs: [], deployedAt: '' };
  return man;
}

/**
 * Brings the game folder to the profile. A file that cannot be changed (the
 * game or launcher keeps it open) does not stop the rest: it is reported in
 * `failed` and stays in the manifest, so the next run tries again.
 */
export async function deploy(o: DeployOptions): Promise<DeployResult> {
  const man = await manifestFor(o.manifestPath, o.root);
  const { want, contenders } = await wantedFiles(o);
  const failed: DeployFailure[] = [];
  let removed = 0;
  let backedUp = 0;
  let deployed = 0;
  const methods = new Set<'hardlink' | 'copy'>();

  try {
    // 1. Remove files we own that are no longer wanted or changed owner.
    for (const [k, owned] of Object.entries(man.files)) {
      const w = want.get(k);
      if (w && w.staged === owned.staged) continue;
      try {
        await fs.rm(path.join(o.root, owned.rel), { force: true });
      } catch (e) {
        failed.push(failure(owned.rel, e));
        continue;
      }
      delete man.files[k];
      removed++;
      if (!w && man.backups.includes(k)) {
        await restoreBackup(o.backupDir, o.root, owned.rel);
        man.backups = man.backups.filter((b) => b !== k);
      }
    }

    // 2. Place wanted files.
    for (const [k, w] of want) {
      const target = path.join(o.root, w.rel);
      const cur = man.files[k];
      if (cur && cur.staged === w.staged && (await exists(target))) {
        methods.add(cur.method);
        continue;
      }
      if (cur && cur.staged !== w.staged) continue; // the old version could not be removed above
      try {
        if (!cur && (await exists(target))) {
          // a file that belongs to the game or the user: keep a copy to restore later
          const bak = path.join(o.backupDir, w.rel);
          await fs.mkdir(path.dirname(bak), { recursive: true });
          await fs.rm(bak, { force: true });
          await fs.rename(target, bak).catch(async () => {
            await fs.copyFile(target, bak);
            await fs.rm(target, { force: true });
          });
          if (!man.backups.includes(k)) man.backups.push(k);
          backedUp++;
        } else {
          await fs.rm(target, { force: true });
        }
        await mkdirTracked(path.dirname(target), o.root, man);
        let method: 'hardlink' | 'copy' = o.method;
        if (method === 'hardlink') {
          try {
            await fs.link(w.staged, target);
          } catch {
            method = 'copy'; // different volume or file system without hard links
          }
        }
        if (method === 'copy') await fs.copyFile(w.staged, target);
        methods.add(method);
        man.files[k] = { ...w, method };
        deployed++;
      } catch (e) {
        failed.push(failure(w.rel, e));
      }
    }

    await removeEmptyDirs(man);
  } finally {
    man.root = o.root;
    man.deployedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(o.manifestPath), { recursive: true });
    await fs.writeFile(o.manifestPath, JSON.stringify(man, null, 1));
  }

  const conflicts = [...contenders]
    .filter(([, keys]) => keys.length > 1)
    .map(([k, keys]) => ({ path: want.get(k)!.rel, winner: keys[keys.length - 1], losers: keys.slice(0, -1) }));
  return {
    deployed,
    removed,
    backedUp,
    method: methods.size > 1 ? 'mixed' : ([...methods][0] ?? o.method),
    conflicts,
    failed,
  };
}

/**
 * How the game folder differs from what the profile wants, without changing it:
 * `missing` — our files that are gone, `stale` — our files that should be gone.
 */
export async function deployDrift(o: DeployOptions): Promise<{ missing: string[]; stale: string[] }> {
  const man = await manifestFor(o.manifestPath, o.root);
  const { want } = await wantedFiles(o);
  const missing: string[] = [];
  const stale: string[] = [];
  for (const [k, owned] of Object.entries(man.files)) {
    const here = await exists(path.join(o.root, owned.rel));
    const w = want.get(k);
    if (w && w.staged === owned.staged) {
      if (!here) missing.push(owned.rel);
    } else if (here) stale.push(owned.rel);
  }
  return { missing, stale };
}

/** Files Lattice placed into the game folder (relative paths), to tell them from foreign ones. */
export async function ownedFiles(manifestPath: string, root: string): Promise<Set<string>> {
  const man = await manifestFor(manifestPath, root);
  return new Set(Object.keys(man.files));
}

/** Takes every file we placed out of the game folder and restores the game's own files. */
export async function purge(manifestPath: string, root: string, backupDir: string): Promise<{ removed: number; failed: DeployFailure[] }> {
  const man = await readManifest(manifestPath, root);
  const base = man.root || root;
  const failed: DeployFailure[] = [];
  const relOf = new Map(Object.entries(man.files).map(([k, f]) => [k, f.rel]));
  let removed = 0;
  for (const [k, owned] of Object.entries(man.files)) {
    try {
      await fs.rm(path.join(base, owned.rel), { force: true });
    } catch (e) {
      failed.push(failure(owned.rel, e));
      continue;
    }
    delete man.files[k];
    removed++;
  }
  for (const k of [...man.backups]) {
    if (man.files[k]) continue; // our file is still there; restore once it is gone
    await restoreBackup(backupDir, base, relOf.get(k) ?? k);
    man.backups = man.backups.filter((b) => b !== k);
  }
  await removeEmptyDirs(man);
  if (failed.length) await fs.writeFile(manifestPath, JSON.stringify(man, null, 1));
  else await fs.rm(manifestPath, { force: true });
  return { removed, failed };
}

async function restoreBackup(backupDir: string, root: string, rel: string) {
  const bak = path.join(backupDir, rel);
  const target = path.join(root, rel);
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(bak, target);
  } catch {
    /* nothing to restore */
  }
}

async function mkdirTracked(dir: string, root: string, man: Manifest) {
  const missing: string[] = [];
  let d = dir;
  while (d.length > root.length && !(await exists(d))) {
    missing.push(d);
    d = path.dirname(d);
  }
  await fs.mkdir(dir, { recursive: true });
  for (const m of missing) if (!man.createdDirs.includes(m)) man.createdDirs.push(m);
}

async function removeEmptyDirs(man: Manifest) {
  const dirs = [...man.createdDirs].sort((a, b) => b.length - a.length);
  for (const d of dirs) {
    try {
      const entries = await fs.readdir(d);
      if (entries.length === 0) {
        await fs.rmdir(d);
        man.createdDirs = man.createdDirs.filter((x) => x !== d);
      }
    } catch {
      man.createdDirs = man.createdDirs.filter((x) => x !== d);
    }
  }
}
