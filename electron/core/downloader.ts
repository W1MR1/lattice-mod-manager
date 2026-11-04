// Segmented downloader. There is no bandwidth throttle anywhere in this file:
// a file is split into byte ranges fetched over parallel connections, and when
// a connection finishes early it takes half of the largest remaining range
// (work stealing), so all connections stay busy until the very end.
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DownloadState, DownloadView, ModFile } from '../../shared/types';
import { APP_VERSION } from './app-info';
import { t } from '../../shared/i18n';

export const USER_AGENT = `Lattice-ModManager/${APP_VERSION} (desktop mod manager)`;

export interface DownloadLimits {
  maxParallel: number;
  maxConnections: number;
  minSegmentBytes: number;
}

export interface DownloadRequest {
  url: string;
  dest: string;
  title: string;
  size?: number;
  hashes?: ModFile['hashes'];
  /** cap for this file, e.g. 1 where a source limits connections per account */
  maxConnections?: number;
  /** game the file is for, to list downloads per game */
  gameId?: string;
}

interface Segment {
  start: number;
  end: number;
  pos: number;
  active: boolean;
  ctrl?: AbortController;
  retries: number;
}

interface Job {
  id: string;
  req: DownloadRequest;
  state: DownloadState;
  url: string;
  size: number;
  received: number;
  rangeSupported: boolean;
  segments: Segment[];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  verified?: DownloadView['verified'];
  meter: { t: number; n: number }[];
  waiters: { resolve: (p: string) => void; reject: (e: Error) => void }[];
  run?: Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DownloadManager extends EventEmitter {
  private jobs = new Map<string, Job>();
  private order: string[] = [];
  private emitTimer: NodeJS.Timeout | null = null;

  constructor(private limits: () => DownloadLimits) {
    super();
  }

  list(): DownloadView[] {
    return this.order.map((id) => this.view(this.jobs.get(id)!));
  }

  /** Resolves with the final file path once downloaded and verified. */
  enqueue(req: DownloadRequest): { id: string; done: Promise<string> } {
    const existing = [...this.jobs.values()].find((j) => j.req.dest === req.dest && !['error', 'cancelled'].includes(j.state));
    const job: Job = existing ?? {
      id: randomUUID(),
      req,
      state: 'queued',
      url: req.url,
      size: req.size ?? 0,
      received: 0,
      rangeSupported: false,
      segments: [],
      meter: [],
      waiters: [],
    };
    if (!existing) {
      this.jobs.set(job.id, job);
      this.order.unshift(job.id);
    }
    const done = new Promise<string>((resolve, reject) => {
      if (job.state === 'done') resolve(job.req.dest);
      else job.waiters.push({ resolve, reject });
    });
    this.pump();
    this.changed();
    return { id: job.id, done };
  }

  pause(id: string) {
    const j = this.jobs.get(id);
    if (!j || !['downloading', 'probing', 'queued'].includes(j.state)) return;
    j.state = 'paused';
    for (const s of j.segments) s.ctrl?.abort();
    this.changed();
  }

  resume(id: string) {
    const j = this.jobs.get(id);
    if (!j || !['paused', 'error'].includes(j.state)) return;
    j.state = 'queued';
    j.error = undefined;
    for (const s of j.segments) s.retries = 0;
    this.pump();
    this.changed();
  }

  cancel(id: string) {
    const j = this.jobs.get(id);
    if (!j) return;
    const wasActive = j.state !== 'done';
    j.state = 'cancelled';
    for (const s of j.segments) s.ctrl?.abort();
    if (wasActive) {
      for (const w of j.waiters.splice(0)) w.reject(new Error(t('Загрузка отменена')));
      void fs.rm(j.req.dest + '.part', { force: true });
    }
    this.changed();
  }

  clearFinished() {
    for (const id of [...this.order]) {
      const j = this.jobs.get(id)!;
      if (['done', 'cancelled', 'error'].includes(j.state)) {
        this.jobs.delete(id);
        this.order = this.order.filter((x) => x !== id);
      }
    }
    this.changed();
  }

  private pump() {
    const { maxParallel } = this.limits();
    const running = [...this.jobs.values()].filter((j) => j.state === 'probing' || j.state === 'downloading' || j.state === 'verifying').length;
    let free = Math.max(1, maxParallel) - running;
    for (const id of [...this.order].reverse()) {
      if (free <= 0) break;
      const j = this.jobs.get(id)!;
      if (j.state !== 'queued') continue;
      free--;
      // mark as started synchronously, or the next pump() would start it again
      j.state = 'probing';
      j.run = this.runJob(j).finally(() => this.pump());
    }
  }

  private async runJob(j: Job) {
    try {
      j.startedAt ??= new Date().toISOString();
      await fs.mkdir(path.dirname(j.req.dest), { recursive: true });
      const cached = await this.verifyExisting(j);
      if (cached) return this.finish(j);

      if (j.segments.length === 0) {
        this.changed();
        await this.probe(j);
      }
      if (this.stopped(j)) return;
      j.state = 'downloading';
      this.changed();

      const part = j.req.dest + '.part';
      if (j.rangeSupported) {
        const fh = await fs.open(part, j.received > 0 ? 'r+' : 'w');
        try {
          if (j.received === 0) await fh.truncate(j.size);
          await this.runSegments(j, fh);
        } finally {
          await fh.close();
        }
      } else {
        await this.runSingle(j, part);
      }
      if (this.stopped(j)) return;

      j.state = 'verifying';
      this.changed();
      j.verified = await verify(part, j.req.hashes);
      await fs.rm(j.req.dest, { force: true });
      await fs.rename(part, j.req.dest);
      this.finish(j);
    } catch (e) {
      if (this.stopped(j)) return;
      j.state = 'error';
      j.error = (e as Error).message;
      for (const w of j.waiters.splice(0)) w.reject(e as Error);
      this.changed();
    }
  }

  private stopped(j: Job) {
    return j.state === 'paused' || j.state === 'cancelled';
  }

  private finish(j: Job) {
    j.state = 'done';
    j.received = j.size;
    j.finishedAt = new Date().toISOString();
    for (const s of j.segments) {
      s.pos = s.end + 1;
      s.active = false;
    }
    for (const w of j.waiters.splice(0)) w.resolve(j.req.dest);
    this.changed();
  }

  private async verifyExisting(j: Job): Promise<boolean> {
    const h = j.req.hashes;
    if (!h || !(h.sha1 || h.sha256 || h.sha512 || h.md5)) return false;
    try {
      const st = await fs.stat(j.req.dest);
      if (!st.isFile()) return false;
      j.verified = await verify(j.req.dest, h);
      j.size = st.size;
      return true;
    } catch {
      return false;
    }
  }

  private connectionsFor(j: Job): number {
    return Math.max(1, Math.min(this.limits().maxConnections, j.req.maxConnections ?? Infinity));
  }

  private async probe(j: Job) {
    const res = await fetch(j.req.url, {
      headers: { Range: 'bytes=0-0', 'User-Agent': USER_AGENT },
      redirect: 'follow',
    });
    if (!res.ok && res.status !== 206) throw new Error(t('Сервер ответил {0} {1}', res.status, res.statusText));
    j.url = res.url || j.req.url;
    const cr = res.headers.get('content-range');
    await res.body?.cancel().catch(() => undefined);
    const total = cr ? Number(cr.split('/')[1]) : NaN;
    if (res.status === 206 && Number.isFinite(total) && total > 0) {
      j.rangeSupported = true;
      j.size = total;
      const { minSegmentBytes } = this.limits();
      const maxConnections = this.connectionsFor(j);
      const n = Math.max(1, Math.min(maxConnections, Math.floor(total / minSegmentBytes) || 1));
      const step = Math.ceil(total / n);
      j.segments = [];
      for (let s = 0; s < total; s += step) j.segments.push({ start: s, end: Math.min(total, s + step) - 1, pos: s, active: false, retries: 0 });
    } else {
      j.rangeSupported = false;
      const len = Number(res.headers.get('content-length'));
      if (res.status !== 206 && Number.isFinite(len) && len > 0) j.size = len;
      j.segments = [{ start: 0, end: Math.max(0, j.size - 1), pos: 0, active: false, retries: 0 }];
    }
  }

  private async runSegments(j: Job, fh: fs.FileHandle) {
    const { minSegmentBytes } = this.limits();
    const maxConnections = this.connectionsFor(j);
    const workers = new Set<Promise<void>>();
    let failure: Error | null = null;

    const start = (seg: Segment) => {
      const p = this.runSegment(j, fh, seg)
        .catch((e) => {
          failure ??= e as Error;
        })
        .finally(() => {
          workers.delete(p);
          if (failure || this.stopped(j)) return;
          // Work stealing: split the biggest unfinished range for an idle connection.
          while (workers.size < maxConnections) {
            const pending = j.segments.find((s) => !s.active && s.pos <= s.end);
            if (pending) {
              start(pending);
              continue;
            }
            const victim = j.segments
              .filter((s) => s.active)
              .sort((a, b) => b.end - b.pos - (a.end - a.pos))[0];
            if (!victim || victim.end - victim.pos + 1 < minSegmentBytes * 2) break;
            const mid = victim.pos + Math.floor((victim.end - victim.pos) / 2);
            const fresh: Segment = { start: mid + 1, end: victim.end, pos: mid + 1, active: false, retries: 0 };
            victim.end = mid;
            j.segments.push(fresh);
            j.segments.sort((a, b) => a.start - b.start);
            start(fresh);
          }
        });
      workers.add(p);
    };

    for (const s of j.segments) if (s.pos <= s.end && workers.size < maxConnections) start(s);
    while (workers.size) await Promise.race(workers);
    if (failure) throw failure;
  }

  private async runSegment(j: Job, fh: fs.FileHandle, seg: Segment) {
    seg.active = true;
    this.progress();
    try {
      while (seg.pos <= seg.end) {
        if (this.stopped(j)) return;
        const ctrl = new AbortController();
        seg.ctrl = ctrl;
        try {
          const res = await fetch(j.url, {
            headers: { Range: `bytes=${seg.pos}-${seg.end}`, 'User-Agent': USER_AGENT },
            signal: ctrl.signal,
          });
          if (res.status === 403 || res.status === 410) {
            // signed CDN links expire: get a fresh one from the original URL
            await res.body?.cancel().catch(() => undefined);
            const again = await fetch(j.req.url, { headers: { Range: 'bytes=0-0', 'User-Agent': USER_AGENT } });
            await again.body?.cancel().catch(() => undefined);
            j.url = again.url || j.req.url;
            throw new Error(`HTTP ${res.status}`);
          }
          if (res.status !== 206 || !res.body) throw new Error(t('HTTP {0} на диапазон', res.status));
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const remaining = seg.end - seg.pos + 1; // `end` may shrink when another connection steals
            if (remaining <= 0) break;
            const chunk = value.length > remaining ? value.subarray(0, remaining) : value;
            await fh.write(chunk, 0, chunk.length, seg.pos);
            seg.pos += chunk.length;
            j.received += chunk.length;
            j.meter.push({ t: Date.now(), n: chunk.length });
            this.progress();
            if (seg.pos > seg.end || this.stopped(j)) break;
          }
          ctrl.abort();
          if (seg.pos <= seg.end && !this.stopped(j)) throw new Error(t('Соединение закрылось раньше времени'));
        } catch (e) {
          if (this.stopped(j)) return;
          if (seg.pos > seg.end) return;
          seg.retries++;
          if (seg.retries > 6) throw new Error(t('Сегмент {0}–{1}: {2}', seg.start, seg.end, (e as Error).message));
          await sleep(Math.min(8000, 400 * 2 ** seg.retries));
        }
      }
    } finally {
      seg.active = false;
      seg.ctrl = undefined;
      this.progress();
    }
  }

  private async runSingle(j: Job, part: string) {
    const seg = j.segments[0];
    seg.active = true;
    j.received = 0;
    seg.pos = 0;
    const ctrl = new AbortController();
    seg.ctrl = ctrl;
    const fh = await fs.open(part, 'w');
    try {
      const res = await fetch(j.url, { headers: { 'User-Agent': USER_AGENT }, signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await fh.write(value, 0, value.length, seg.pos);
        seg.pos += value.length;
        j.received += value.length;
        j.meter.push({ t: Date.now(), n: value.length });
        if (j.size === 0 || seg.pos > j.size) seg.end = seg.pos - 1;
        this.progress();
        if (this.stopped(j)) {
          ctrl.abort();
          return;
        }
      }
      j.size = j.received;
      seg.end = Math.max(0, j.size - 1);
    } catch (e) {
      if (!this.stopped(j)) throw e;
    } finally {
      seg.active = false;
      await fh.close();
    }
  }

  private speed(j: Job): number {
    const now = Date.now();
    j.meter = j.meter.filter((m) => now - m.t < 2000);
    if (j.state !== 'downloading') return 0;
    const bytes = j.meter.reduce((a, m) => a + m.n, 0);
    return bytes / 2;
  }

  private view(j: Job): DownloadView {
    let host = '';
    try {
      host = new URL(j.req.url).host;
    } catch {
      /* keep empty */
    }
    return {
      id: j.id,
      url: j.req.url,
      host,
      filename: path.basename(j.req.dest),
      title: j.req.title,
      state: j.state,
      size: j.size,
      received: Math.min(j.received, j.size || j.received),
      speed: this.speed(j),
      segments: j.segments.map((s) => ({ start: s.start, end: s.end, pos: s.pos, active: s.active })),
      connections: j.segments.filter((s) => s.active).length,
      rangeSupported: j.rangeSupported,
      error: j.error,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      verified: j.verified,
      gameId: j.req.gameId,
    };
  }

  /** State transitions (done, error, pause…) are sent at once so the UI never ends on a stale frame. */
  private changed() {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    this.emit('update', this.list());
  }

  /** Byte progress is coalesced to at most five updates a second. */
  private progress() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit('update', this.list());
    }, 200);
  }
}

/** Checks the strongest hash available. Throws on mismatch. */
export async function verify(file: string, hashes?: ModFile['hashes']): Promise<DownloadView['verified']> {
  const algo = hashes?.sha512 ? 'sha512' : hashes?.sha256 ? 'sha256' : hashes?.sha1 ? 'sha1' : hashes?.md5 ? 'md5' : null;
  if (!algo || !hashes) return 'none';
  const expected = hashes[algo]!.toLowerCase();
  const actual = await hashFile(file, algo);
  if (actual !== expected) throw new Error(t('Хэш {0} не совпал: файл повреждён или подменён', algo));
  return algo;
}

export function hashFile(file: string, algo: 'sha1' | 'sha256' | 'sha512' | 'md5'): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash(algo);
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}
