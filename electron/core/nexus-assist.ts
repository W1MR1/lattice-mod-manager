// Nexus without Premium.
//
// Nexus gives files to free accounts only through its own site: the user
// presses the download button there. Lattice does everything around that
// press: opens the right page, takes the file the browser saved (or the nxm
// link the site sent), checks it is the file the plan asked for, and goes on.
// Nothing here goes around Nexus' rules or its speed limit.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModFile, NexusNeed } from '../../shared/types';
import { archiveKind } from './archives';
import { parseNexusArchiveName } from './importers';
import { parseNexusUrl, type NxmLink } from './sources/nexus';
import { t } from '../../shared/i18n';

export interface NexusHost {
  /** Nexus files of an open plan, one per plan item that has one; throws when the plan is gone */
  planFiles(planId: string): Promise<{ key: string; title: string; file: ModFile }[]>;
  cachePath(f: ModFile): string;
  /** the folder the browser saves downloads to */
  folder(): string;
  hasKey(): boolean;
  premium(): boolean;
  /** nxm:// links come to Lattice (the user switched that on) */
  opensNxm(): boolean;
  /** the download key the site sent for a file, if it did */
  link(domain: string, modId: number, fileId: number): NxmLink | undefined;
  /** downloads a file through the API (needs a key and a link) */
  fetch(f: ModFile, title: string): Promise<string>;
  /** tells the window that the list of a plan changed */
  changed(planId: string, needs: NexusNeed[]): void;
}

interface Pickup {
  needs: NexusNeed[];
  files: Map<number, ModFile>;
  /** sizes seen on the last look, to tell a finished download from a growing one */
  sizes: Map<string, number>;
}

const LOOK_EVERY = 1500;

export class NexusAssist {
  private pickups = new Map<string, Pickup>();
  private timer: NodeJS.Timeout | null = null;
  private looking = false;

  constructor(private host: NexusHost) {}

  private async cached(f: ModFile): Promise<boolean> {
    return !!(await fs.stat(this.host.cachePath(f)).catch(() => null))?.isFile();
  }

  /** Nexus files of a plan that Lattice cannot fetch by itself: no Premium, and no download key from the site yet. */
  async needs(planId: string): Promise<NexusNeed[]> {
    const items = await this.host.planFiles(planId);
    const key = this.host.hasKey();
    if (key && this.host.premium()) return [];
    const via: NexusNeed['via'] = key && this.host.opensNxm() ? 'manager' : 'browser';
    const out: NexusNeed[] = [];
    const files = new Map<number, ModFile>();
    for (const it of items) {
      const nx = parseNexusUrl(it.file.url);
      if (!nx || (await this.cached(it.file))) continue;
      const link = this.host.link(nx.domain, nx.modId, nx.fileId);
      if (key && link && (!link.expires || link.expires * 1000 > Date.now())) continue;
      files.set(nx.fileId, it.file);
      out.push({
        key: it.key,
        title: it.title,
        ...nx,
        filename: it.file.filename,
        size: it.file.size,
        page: `https://www.nexusmods.com/${nx.domain}/mods/${nx.modId}?tab=files&file_id=${nx.fileId}${via === 'manager' ? '&nmm=1' : ''}`,
        via,
        state: 'waiting',
      });
    }
    const cur = this.pickups.get(planId);
    if (cur) {
      cur.needs = out;
      cur.files = files;
    }
    return out;
  }

  /** Starts or stops watching the downloads folder for the files a plan waits for. */
  async pickup(planId: string, on: boolean): Promise<NexusNeed[]> {
    if (!on) {
      this.pickups.delete(planId);
      if (this.pickups.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      return [];
    }
    this.pickups.set(planId, { needs: [], files: new Map(), sizes: new Map() });
    const needs = await this.needs(planId);
    if (needs.length === 0) return this.pickup(planId, false);
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick().catch(() => undefined), LOOK_EVERY);
      this.timer.unref?.();
    }
    await this.tick().catch(() => undefined);
    return this.pickups.get(planId)?.needs ?? [];
  }

  /** Does a file in the downloads folder look like the one a plan waits for? */
  private matches(name: string, need: NexusNeed): boolean {
    if (/\.(crdownload|part|partial|tmp|download)$/i.test(name) || !archiveKind(name)) return false;
    // browsers add " (1)" to a name that is taken
    const plain = name.replace(/ \(\d+\)(?=\.[^.]+$)/, '').toLowerCase();
    if (plain === need.filename.toLowerCase()) return true;
    const ids = parseNexusArchiveName(plain.replace(/\.[^.]+$/, ''));
    return !!ids && ids.modId === need.modId && !!need.size;
  }

  /** One look into the downloads folder: finished files that plans wait for move into Lattice's cache. */
  async tick() {
    if (this.looking) return;
    this.looking = true;
    try {
      await this.look();
    } finally {
      this.looking = false;
    }
  }

  private async look() {
    const dir = this.host.folder();
    const entries = (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isFile());
    for (const [planId, p] of this.pickups) {
      let changed = false;
      for (const need of p.needs) {
        if (need.state !== 'waiting') continue;
        const file = p.files.get(need.fileId);
        if (!file) continue;
        for (const e of entries) {
          if (!this.matches(e.name, need)) continue;
          const from = path.join(dir, e.name);
          const st = await fs.stat(from).catch(() => null);
          if (!st || st.size === 0) continue;
          // the file is whole when it has the size Nexus names, or stopped growing between two looks
          const whole = need.size ? st.size === need.size : p.sizes.get(from) === st.size;
          p.sizes.set(from, st.size);
          if (!whole) continue;
          const dest = this.host.cachePath(file);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.rename(from, dest).catch(async () => {
            await fs.copyFile(from, dest);
            await fs.rm(from, { force: true });
          });
          need.state = 'found';
          changed = true;
          break;
        }
      }
      if (changed) this.host.changed(planId, p.needs);
    }
  }

  /** A file the user points at for a waiting download (it is copied, the original stays). */
  async provide(planId: string, fileId: number, source: string): Promise<NexusNeed[]> {
    const p = this.pickups.get(planId);
    const need = p?.needs.find((n) => n.fileId === fileId);
    const file = p?.files.get(fileId);
    if (!p || !need || !file) throw new Error(t('План устарел, постройте его заново'));
    const st = await fs.stat(source).catch(() => null);
    if (!st?.isFile() || !archiveKind(source)) throw new Error(t('Нужен архив мода: .zip, .7z или .rar'));
    if (need.size && st.size !== need.size) throw new Error(t('Это другой файл: у «{0}» на Nexus размер {1} байт, а у выбранного — {2}.', need.filename, need.size, st.size));
    const dest = this.host.cachePath(file);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(source, dest);
    need.state = 'found';
    this.host.changed(planId, p.needs);
    return p.needs;
  }

  /** Mods taken out of a plan are not waited for any more. */
  drop(planId: string, keys: Set<string>) {
    const p = this.pickups.get(planId);
    if (p) p.needs = p.needs.filter((n) => !keys.has(n.key));
  }

  /**
   * An nxm:// link arrived. When a plan is waiting for that very file, it is
   * downloaded now and the plan goes on; returns false when no plan wanted it.
   */
  async offer(link: NxmLink): Promise<boolean> {
    for (const [planId, p] of this.pickups) {
      const need = p.needs.find((n) => n.state === 'waiting' && n.domain === link.domain && n.modId === link.modId && n.fileId === link.fileId);
      const file = need && p.files.get(need.fileId);
      if (!need || !file) continue;
      need.state = 'downloading';
      this.host.changed(planId, p.needs);
      try {
        await this.host.fetch(file, need.title);
        need.state = 'found';
      } catch (e) {
        need.state = 'waiting';
        this.host.changed(planId, p.needs);
        throw e;
      }
      this.host.changed(planId, p.needs);
      return true;
    }
    return false;
  }
}
