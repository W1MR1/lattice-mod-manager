// Disk hygiene: nothing Lattice downloaded or prepared stays without a reason.
// A downloaded file or a prepared copy of a mod is kept while a profile, an
// open plan or a snapshot uses it; everything else is found here and freed.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { InstallPlan, ModFile } from '../../shared/types';
import { STAGED_PREFIX, walk } from './installer';
import type { Persisted } from './store';

export interface DiskHost {
  dir(...p: string[]): string;
  state(): Persisted;
  /** plans still on screen: what they downloaded waits for them */
  openPlans(): Iterable<InstallPlan>;
  /** names of files being downloaded right now */
  activeDownloads(): string[];
  cachePath(f: ModFile): string;
  /** an operation is writing to the cache: cleaning waits */
  busy(): boolean;
}

export interface DiskUsage {
  downloads: number;
  staging: number;
  unused: number;
  unusedCount: number;
  snapshots: number;
  snapshotCount: number;
  quarantine: number;
  quarantinePath: string;
}

interface Entry {
  path: string;
  size: number;
  /** `snapshot`: only a snapshot still needs it; `unused`: nothing does */
  kind: 'unused' | 'snapshot';
}

/** Bytes in a folder and everything under it. */
export async function dirSize(p: string): Promise<number> {
  let n = 0;
  for (const rel of await walk(p).catch(() => [] as string[])) n += (await fs.stat(path.join(p, rel)).catch(() => null))?.size ?? 0;
  return n;
}

const norm = (p: string) => path.resolve(p).toLowerCase();
const dirsOf = async (p: string) => (await fs.readdir(p, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => path.join(p, e.name));
const QUARANTINE_DAYS = 7;

export class DiskKeeper {
  constructor(private host: DiskHost) {}

  /** Folders of the cache that profiles and open plans use (`live`) and that only snapshots keep (`snap`). */
  private used() {
    const live = new Set<string>();
    const snap = new Set<string>();
    const keep = (set: Set<string>, m: { stagedPath?: string; files: ModFile[] }) => {
      if (m.stagedPath) set.add(norm(m.stagedPath));
      for (const f of m.files) if (/^https?:|^nexus:/.test(f.url)) set.add(norm(path.dirname(this.host.cachePath(f))));
    };
    const s = this.host.state();
    for (const m of s.profiles.flatMap((p) => Object.values(p.mods))) keep(live, m);
    // a plan still on screen keeps what it has downloaded, so trying again does not download again
    for (const plan of this.host.openPlans()) for (const it of [...plan.install, ...plan.update]) keep(live, { files: it.version.files });
    for (const m of s.snapshots.flatMap((x) => Object.values(x.mods))) keep(snap, m);
    return { live, snap };
  }

  /** Prepared copies and downloaded files no profile or open plan uses: kept only by snapshots, or by nothing. */
  private async entries(): Promise<Entry[]> {
    const { live, snap } = this.used();
    const active = new Set(this.host.activeDownloads().map((n) => n.toLowerCase()));
    const out: Entry[] = [];
    const add = async (p: string) => {
      const k = norm(p);
      if (!live.has(k)) out.push({ path: p, size: await dirSize(p), kind: snap.has(k) ? 'snapshot' : 'unused' });
    };
    for (const gameDir of await dirsOf(this.host.dir('staging'))) {
      const base = path.basename(gameDir);
      if (base === '_shared') {
        // settings of imported modpacks: kept while their collection is in the library or a profile uses them
        const kept = new Set(
          this.host
            .state()
            .collections.flatMap((c) => c.mods.flatMap((m) => m.files.filter((f) => f.url.startsWith(STAGED_PREFIX)).map((f) => norm(f.url.slice(STAGED_PREFIX.length))))),
        );
        for (const coll of await dirsOf(path.join(gameDir, '_collections'))) {
          for (const part of await dirsOf(coll)) {
            const k = norm(part);
            if (!kept.has(k) && !live.has(k)) out.push({ path: part, size: await dirSize(part), kind: snap.has(k) ? 'snapshot' : 'unused' });
          }
        }
        for (const left of await dirsOf(path.join(gameDir, '_import'))) out.push({ path: left, size: await dirSize(left), kind: 'unused' }); // an import that was cut short
        continue;
      }
      if (base === '_import') {
        out.push({ path: gameDir, size: await dirSize(gameDir), kind: 'unused' }); // leftovers of unpacked modpacks
        continue;
      }
      for (const modDir of await dirsOf(gameDir)) for (const verDir of await dirsOf(modDir)) await add(verDir);
    }
    for (const a of await dirsOf(this.host.dir('downloads'))) {
      for (const b of await dirsOf(a)) {
        const files = await fs.readdir(b).catch(() => [] as string[]);
        if (files.some((f) => active.has(f.replace(/\.part$/, '').toLowerCase()))) continue;
        await add(b);
      }
    }
    return out;
  }

  /** How much space Lattice takes, how much only snapshots keep, and how much nothing needs. */
  async usage(): Promise<DiskUsage> {
    const all = await this.entries();
    const sum = (k: Entry['kind']) => all.filter((e) => e.kind === k).reduce((a, x) => a + x.size, 0);
    return {
      downloads: await dirSize(this.host.dir('downloads')),
      staging: await dirSize(this.host.dir('staging')),
      unused: sum('unused'),
      unusedCount: all.filter((e) => e.kind === 'unused').length,
      snapshots: sum('snapshot'),
      snapshotCount: this.host.state().snapshots.length,
      quarantine: await dirSize(this.host.dir('quarantine')),
      quarantinePath: this.host.dir('quarantine'),
    };
  }

  /** Deletes what nothing needs; empty mod folders go too. */
  async free(): Promise<{ removed: number; freed: number }> {
    if (this.host.busy()) return { removed: 0, freed: 0 };
    let removed = 0;
    let freed = 0;
    for (const e of (await this.entries()).filter((x) => x.kind === 'unused')) {
      await fs.rm(e.path, { recursive: true, force: true }).then(
        () => {
          removed++;
          freed += e.size;
        },
        () => undefined,
      );
      const parent = path.dirname(e.path);
      if (!(await fs.readdir(parent).catch(() => ['x'])).length) await fs.rmdir(parent).catch(() => undefined);
    }
    return { removed, freed };
  }

  /** At start: quarantine older than a week goes, then what a crash or a quick exit left behind. */
  async cleanup() {
    const old = Date.now() - QUARANTINE_DAYS * 24 * 3600 * 1000;
    const q = this.host.dir('quarantine');
    for (const e of await fs.readdir(q, { withFileTypes: true }).catch(() => [])) {
      const born = Number(e.name.split('-')[0]);
      if (e.isDirectory() && Number.isFinite(born) && born < old) await fs.rm(path.join(q, e.name), { recursive: true, force: true }).catch(() => undefined);
    }
    if (!(await fs.readdir(q).catch(() => ['x'])).length) await fs.rmdir(q).catch(() => undefined);
    await this.free().catch(() => undefined);
  }

  /** Cleaning after an operation, without bothering the user. */
  tidy() {
    setTimeout(() => void this.free().catch(() => undefined), 500);
  }
}
