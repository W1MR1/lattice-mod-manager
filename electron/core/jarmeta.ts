// What a Minecraft mod jar declares about itself: its ids, what it needs and
// what it breaks (fabric.mod.json, quilt.mod.json, META-INF/mods.toml), including
// the mods bundled inside it (jar-in-jar). The loader refuses to start the game
// when such a dependency is missing, so Lattice checks the same before launch.
import fs from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

export interface JarDep {
  id: string;
  range?: string;
}

export interface JarMeta {
  /** ids this jar and the jars bundled in it provide */
  ids: string[];
  /** version of each provided id, where the descriptor states one */
  versions: Record<string, string>;
  /** loaders the jar itself is made for (its own descriptors, not bundled jars) */
  loaders?: string[];
  depends: JarDep[];
  breaks: JarDep[];
}

const EMPTY: JarMeta = { ids: [], versions: {}, depends: [], breaks: [] };

/** Ids the loader or the game itself provide. */
export const BUILTIN_IDS = new Set(['minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'quilt_base', 'forge', 'neoforge', 'javafml', 'lowcodefml', 'mixinextras']);

// ---------- a small ZIP reader (jars are ZIP files with stored or deflated entries)

interface Entry {
  name: string;
  method: number;
  compSize: number;
  localOffset: number;
}

function entries(buf: Buffer): Entry[] {
  // end of central directory: the last record with the 0x06054b50 signature
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Entry[] = [];
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    out.push({ name: buf.toString('utf8', p + 46, p + 46 + nameLen), method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function read(buf: Buffer, e: Entry): Buffer | null {
  const p = e.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) return null;
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + e.compSize);
  try {
    if (e.method === 0) return Buffer.from(data);
    if (e.method === 8) return inflateRawSync(data);
  } catch {
    return null;
  }
  return null;
}

// ---------- the descriptors

function depsOf(obj: unknown): JarDep[] {
  if (!obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) {
    // quilt: ["id", {id, versions, optional}]
    return obj.flatMap((d) => (typeof d === 'string' ? [{ id: d }] : d && typeof d === 'object' && typeof d.id === 'string' && !d.optional ? [{ id: d.id, range: typeof d.versions === 'string' ? d.versions : undefined }] : []));
  }
  return Object.entries(obj as Record<string, unknown>).map(([id, v]) => ({ id, range: typeof v === 'string' ? v : Array.isArray(v) ? v.join(' || ') : undefined }));
}

function parseJson<T>(b: Buffer | null): T | null {
  if (!b) return null;
  try {
    // some mods ship comments or control characters in fabric.mod.json
    return JSON.parse(b.toString('utf8').replace(/^﻿/, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')) as T;
  } catch {
    return null;
  }
}

/** Forge and NeoForge mods.toml: mod ids ([[mods]]) and required or incompatible dependencies. */
export function parseModsToml(text: string): { ids: string[]; depends: JarDep[]; breaks: JarDep[] } {
  const ids: string[] = [];
  const depends: JarDep[] = [];
  const breaks: JarDep[] = [];
  // split keeps the [[headers]]: [before, header, body, header, body, ...]
  const parts = text.split(/^\s*\[\[\s*([^\]]+?)\s*\]\]\s*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const header = parts[i];
    const body = (parts[i + 1] ?? '').split(/^\s*\[/m)[0];
    const id = /^\s*modId\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    if (!id) continue;
    if (header === 'mods') {
      ids.push(id);
      continue;
    }
    if (!header.startsWith('dependencies')) continue;
    const range = /^\s*versionRange\s*=\s*"([^"]*)"/m.exec(body)?.[1];
    const type = /^\s*type\s*=\s*"(\w+)"/m.exec(body)?.[1]?.toLowerCase();
    const mandatory = /^\s*mandatory\s*=\s*true/m.test(body);
    if (type === 'required' || (!type && mandatory)) depends.push({ id, range });
    else if (type === 'incompatible') breaks.push({ id, range });
  }
  return { ids, depends, breaks };
}

function metaOfBuffer(buf: Buffer, depth = 0): JarMeta {
  const list = entries(buf);
  const byName = new Map(list.map((e) => [e.name, e]));
  const get = (n: string) => (byName.has(n) ? read(buf, byName.get(n)!) : null);
  const ids: string[] = [];
  const versions: Record<string, string> = {};
  const depends: JarDep[] = [];
  const breaks: JarDep[] = [];
  const own = (list: string[], version?: string) => {
    ids.push(...list);
    if (version && !version.includes('$')) for (const id of list) versions[id.toLowerCase()] ??= version;
  };

  const loaders: string[] = [];
  const fabric = parseJson<{ id?: string; version?: string; provides?: string[]; depends?: unknown; breaks?: unknown }>(get('fabric.mod.json'));
  if (fabric?.id) {
    loaders.push('fabric');
    own([fabric.id, ...(fabric.provides ?? [])], fabric.version);
    depends.push(...depsOf(fabric.depends));
    breaks.push(...depsOf(fabric.breaks));
  }
  const quilt = parseJson<{ quilt_loader?: { id?: string; version?: string; provides?: (string | { id: string })[]; depends?: unknown; breaks?: unknown } }>(get('quilt.mod.json'))?.quilt_loader;
  if (quilt?.id) {
    loaders.push('quilt');
    own([quilt.id, ...(quilt.provides ?? []).map((p) => (typeof p === 'string' ? p : p.id))], quilt.version);
    depends.push(...depsOf(quilt.depends));
    breaks.push(...depsOf(quilt.breaks));
  }
  for (const toml of ['META-INF/mods.toml', 'META-INF/neoforge.mods.toml']) {
    const b = get(toml);
    if (!b) continue;
    const m = parseModsToml(b.toString('utf8'));
    // mods.toml serves Forge and early NeoForge; neoforge.mods.toml is NeoForge only
    loaders.push(...(toml.startsWith('META-INF/neoforge') ? ['neoforge'] : ['forge', 'neoforge']));
    own(m.ids);
    depends.push(...m.depends);
    breaks.push(...m.breaks);
  }

  // bundled mods (Fabric/Quilt: META-INF/jars, Forge/NeoForge: META-INF/jarjar)
  if (depth < 2) {
    for (const e of list) {
      if (!/^META-INF\/(jars|jarjar)\/.+\.jar$/i.test(e.name)) continue;
      const inner = read(buf, e);
      if (!inner) continue;
      const m = metaOfBuffer(inner, depth + 1);
      ids.push(...m.ids);
      for (const [k, v] of Object.entries(m.versions)) versions[k] ??= v;
    }
  }
  return { ids: [...new Set(ids)], versions, depends, breaks, loaders: [...new Set(loaders)] };
}

/** Reads a jar; a file that is not a readable jar declares nothing. */
export async function readJarMeta(file: string): Promise<JarMeta> {
  try {
    return metaOfBuffer(await fs.readFile(file));
  } catch {
    return EMPTY;
  }
}

export { metaOfBuffer as jarMetaOfBuffer };
