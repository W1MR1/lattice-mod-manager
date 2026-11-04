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

async function stagedFiles(dir: string): Promise<string[]> {
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

export async function deploy(o: DeployOptions): Promise<DeployResult> {
  const man = await readManifest(o.manifestPath, o.root);
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

  let removed = 0;
  let backedUp = 0;
  let deployed = 0;
  const methods = new Set<'hardlink' | 'copy'>();

  // 1. Remove files we own that are no longer wanted or changed owner.
  for (const [k, owned] of Object.entries(man.files)) {
    const w = want.get(k);
    if (w && w.staged === owned.staged) continue;
    const target = path.join(o.root, owned.rel);
    await fs.rm(target, { force: true });
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
  }

  await removeEmptyDirs(man);
  man.deployedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(o.manifestPath), { recursive: true });
  await fs.writeFile(o.manifestPath, JSON.stringify(man, null, 1));

  const conflicts = [...contenders]
    .filter(([, keys]) => keys.length > 1)
    .map(([k, keys]) => ({ path: want.get(k)!.rel, winner: keys[keys.length - 1], losers: keys.slice(0, -1) }));
  return {
    deployed,
    removed,
    backedUp,
    method: methods.size > 1 ? 'mixed' : ([...methods][0] ?? o.method),
    conflicts,
  };
}

export async function purge(manifestPath: string, root: string, backupDir: string): Promise<number> {
  const man = await readManifest(manifestPath, root);
  let n = 0;
  for (const owned of Object.values(man.files)) {
    await fs.rm(path.join(root, owned.rel), { force: true });
    n++;
  }
  for (const k of man.backups) {
    const rel = Object.values(man.files).find((f) => norm(f.rel) === k)?.rel ?? k;
    await restoreBackup(backupDir, root, rel);
  }
  man.files = {};
  man.backups = [];
  await removeEmptyDirs(man);
  await fs.rm(manifestPath, { force: true });
  return n;
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
