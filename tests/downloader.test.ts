import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DownloadManager } from '../electron/core/downloader';

const SIZE = 6 * 1024 * 1024 + 123;
const body = randomBytes(SIZE);
const sha512 = createHash('sha512').update(body).digest('hex');
let server: http.Server;
let base = '';
let maxConcurrent = 0;
let active = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const ranged = req.url?.startsWith('/ranged');
    const range = req.headers.range;
    active++;
    maxConcurrent = Math.max(maxConcurrent, active);
    res.on('close', () => active--);
    if (ranged && range) {
      const [s, e] = range.replace('bytes=', '').split('-').map(Number);
      const end = Math.min(e, SIZE - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${s}-${end}/${SIZE}`, 'Content-Length': end - s + 1, 'Accept-Ranges': 'bytes' });
      // send in small slices so several connections overlap in time
      const slow = req.url?.includes('slow');
      let pos = s;
      const tick = () => {
        if (pos > end || res.destroyed) return res.end();
        const next = Math.min(end + 1, pos + (slow ? 64 : 128) * 1024);
        res.write(body.subarray(pos, next));
        pos = next;
        setTimeout(tick, slow ? 15 : 2);
      };
      tick();
      return;
    }
    res.writeHead(200, { 'Content-Length': SIZE });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'lattice-dl-'));

describe('DownloadManager', () => {
  it('downloads over several parallel range connections and verifies the hash', async () => {
    const dir = await tmp();
    const dm = new DownloadManager(() => ({ maxParallel: 4, maxConnections: 6, minSegmentBytes: 512 * 1024 }));
    const { done, id } = dm.enqueue({ url: `${base}/ranged`, dest: path.join(dir, 'f.bin'), title: 'f', hashes: { sha512 } });
    const file = await done;
    const got = await fs.readFile(file);
    expect(got.equals(body)).toBe(true);
    const view = dm.list().find((d) => d.id === id)!;
    expect(view.rangeSupported).toBe(true);
    expect(view.segments.length).toBeGreaterThanOrEqual(6);
    expect(view.verified).toBe('sha512');
    expect(maxConcurrent).toBeGreaterThan(2);
  });

  it('starts each job once when many are queued at the same moment', async () => {
    const dir = await tmp();
    const dm = new DownloadManager(() => ({ maxParallel: 6, maxConnections: 8, minSegmentBytes: 1024 * 1024 }));
    let probes = 0;
    const counted = server.listeners('request')[0] as (...a: unknown[]) => void;
    const spy = (req: http.IncomingMessage, res: http.ServerResponse) => {
      if (req.headers.range === 'bytes=0-0') probes++;
      counted(req, res);
    };
    server.removeAllListeners('request');
    server.on('request', spy);
    try {
      const jobs = [1, 2, 3, 4, 5].map((n) => dm.enqueue({ url: `${base}/ranged?f=${n}`, dest: path.join(dir, `${n}.bin`), title: `f${n}`, hashes: { sha512 } }).done);
      const files = await Promise.all(jobs);
      for (const f of files) expect((await fs.readFile(f)).equals(body)).toBe(true);
      expect(probes).toBe(5);
    } finally {
      server.removeAllListeners('request');
      server.on('request', counted);
    }
  });

  it('falls back to one connection when the server ignores ranges', async () => {
    const dir = await tmp();
    const dm = new DownloadManager(() => ({ maxParallel: 2, maxConnections: 8, minSegmentBytes: 512 * 1024 }));
    const { done, id } = dm.enqueue({ url: `${base}/plain`, dest: path.join(dir, 'p.bin'), title: 'p' });
    const got = await fs.readFile(await done);
    expect(got.equals(body)).toBe(true);
    expect(dm.list().find((d) => d.id === id)!.rangeSupported).toBe(false);
  });

  it('rejects a file whose hash does not match', async () => {
    const dir = await tmp();
    const dm = new DownloadManager(() => ({ maxParallel: 2, maxConnections: 4, minSegmentBytes: 512 * 1024 }));
    const { done } = dm.enqueue({ url: `${base}/ranged`, dest: path.join(dir, 'bad.bin'), title: 'bad', hashes: { sha1: 'deadbeef' } });
    await expect(done).rejects.toThrow(/Хэш/);
  });

  it('pauses and resumes without corrupting the file', async () => {
    const dir = await tmp();
    const dm = new DownloadManager(() => ({ maxParallel: 1, maxConnections: 4, minSegmentBytes: 512 * 1024 }));
    const { done, id } = dm.enqueue({ url: `${base}/ranged-slow`, dest: path.join(dir, 'r.bin'), title: 'r', hashes: { sha512 } });
    await new Promise((r) => setTimeout(r, 80));
    dm.pause(id);
    await new Promise((r) => setTimeout(r, 100));
    const paused = dm.list().find((d) => d.id === id)!;
    expect(paused.state).toBe('paused');
    expect(paused.received).toBeGreaterThan(0);
    expect(paused.received).toBeLessThan(SIZE);
    dm.resume(id);
    const got = await fs.readFile(await done);
    expect(got.equals(body)).toBe(true);
  });
});
