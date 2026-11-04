// JSON GET with a short in-memory cache and polite handling of rate limits.
import { gunzipSync } from 'node:zlib';
import { USER_AGENT } from './downloader';

const cache = new Map<string, { at: number; value: unknown }>();
const TTL = 60_000;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function getJson<T>(url: string, headers: Record<string, string> = {}, ttl = TTL): Promise<T> {
  // answers depend on the key or token sent, not only on the address
  const cacheKey = Object.keys(headers).length ? `${url}
${JSON.stringify(headers)}` : url;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < ttl) return hit.value as T;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers } });
    } catch (e) {
      // connection reset / DNS hiccup: retry a couple of times before giving up
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      continue;
    }
    if (res.status === 429 && attempt < 3) {
      const wait = Number(res.headers.get('retry-after')) || 2 ** attempt;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HttpError(res.status, `${res.status} ${res.statusText}${text ? `: ${text.slice(0, 160)}` : ''}`);
    }
    const value = (await res.json()) as T;
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  }
}

export async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new HttpError(res.status, `${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/**
 * Fetches a JSON document that may be served gzip-compressed without a
 * Content-Encoding header. Transient network failures are retried.
 */
export async function getMaybeGzipJson<T>(url: string, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new HttpError(res.status, `${res.status} ${res.statusText}`);
      let buf = Buffer.from(await res.arrayBuffer());
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
      return JSON.parse(buf.toString('utf8')) as T;
    } catch (e) {
      const fatal = e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 429;
      if (fatal || i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}

/** Maps with at most `limit` promises in flight. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
