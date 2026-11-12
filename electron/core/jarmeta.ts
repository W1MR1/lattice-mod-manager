// What a Minecraft mod jar declares about itself: its ids, what it needs and
// what it breaks (fabric.mod.json, quilt.mod.json, META-INF/mods.toml), including
// the mods bundled inside it (jar-in-jar). The loader refuses to start the game
// when such a dependency is missing, so Lattice checks the same before launch.
//
// One jar often serves several loaders and says different things to each: a
// Fabric + Quilt + Forge jar asks Quilt for quilt_resource_loader and Forge for
// cloth_config, and neither matters on Fabric. So every descriptor is kept
// apart, and `jarView` answers for the loader the profile really runs.
import fs from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

export interface JarDep {
  id: string;
  range?: string;
}

export type JarLoader = 'fabric' | 'quilt' | 'forge' | 'neoforge';

/** What one descriptor of a jar declares (to one loader). */
export interface JarDescriptor {
  /** ids the jar provides to this loader, bundled jars included */
  ids: string[];
  versions: Record<string, string>;
  depends: JarDep[];
  breaks: JarDep[];
}

export interface JarMeta {
  /** ids this jar and the jars bundled in it provide, to any loader */
  ids: string[];
  /** version of each provided id, where the descriptor states one */
  versions: Record<string, string>;
  /** loaders the jar itself is made for (its own descriptors, not bundled jars) */
  loaders?: string[];
  /** everything any descriptor asks for; use `jarView` to ask for one loader */
  depends: JarDep[];
  breaks: JarDep[];
  /** the same, apart for each loader the jar has a descriptor for */
  by?: Partial<Record<JarLoader, JarDescriptor>>;
}

const EMPTY: JarMeta = { ids: [], versions: {}, depends: [], breaks: [] };

/** Ids the loader or the game itself provide, whatever the loader. */
export const BUILTIN_IDS = new Set(['minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'quilt_base', 'forge', 'neoforge', 'javafml', 'lowcodefml', 'mixinextras']);

/** Ids each loader brings along with the game. */
const BUILTIN_BY_LOADER: Record<JarLoader, string[]> = {
  fabric: ['minecraft', 'java', 'fabricloader', 'fabric-loader', 'mixinextras'],
  // Quilt Loader answers to fabricloader as well, so Fabric mods load on it
  quilt: ['minecraft', 'java', 'quilt_loader', 'fabricloader', 'fabric-loader', 'mixinextras'],
  forge: ['minecraft', 'java', 'forge', 'javafml', 'lowcodefml', 'mixinextras'],
  neoforge: ['minecraft', 'java', 'neoforge', 'javafml', 'lowcodefml', 'mixinextras'],
};

export function builtinIds(loader?: string): Set<string> {
  return new Set(BUILTIN_BY_LOADER[loader as JarLoader] ?? BUILTIN_IDS);
}

/** Which descriptor a loader reads: its own first, then the one it understands as well. */
const READS: Record<JarLoader, JarLoader[]> = {
  fabric: ['fabric'],
  quilt: ['quilt', 'fabric'],
  forge: ['forge'],
  neoforge: ['neoforge', 'forge'],
};

export interface JarView extends JarDescriptor {
  /** true when the jar has a descriptor this loader reads: its word is final */
  known: boolean;
}

/**
 * What a jar declares to one loader. Without a loader (or for an unknown one)
 * everything the jar says to anybody is returned, as before.
 */
export function jarView(meta: JarMeta | undefined, loader?: string): JarView {
  if (!meta) return { ids: [], versions: {}, depends: [], breaks: [], known: false };
  const order = READS[loader as JarLoader];
  const whole = { ids: meta.ids, versions: meta.versions, depends: meta.depends, breaks: meta.breaks };
  // read without descriptors kept apart: the whole is all there is to go by
  if (!meta.by) return { ...whole, known: meta.ids.length > 0 };
  if (!order) return { ...whole, known: Object.keys(meta.by).length > 0 };
  for (const l of order) {
    const d = meta.by[l];
    if (d) return { ...d, known: true };
  }
  return { ids: [], versions: {}, depends: [], breaks: [], known: false };
}

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
  const by: Partial<Record<JarLoader, JarDescriptor>> = {};
  const desc = (l: JarLoader): JarDescriptor => (by[l] ??= { ids: [], versions: {}, depends: [], breaks: [] });
  const own = (l: JarLoader, list: string[], version?: string) => {
    const d = desc(l);
    d.ids.push(...list);
    if (version && !version.includes('$')) for (const id of list) d.versions[id.toLowerCase()] ??= version;
  };

  const fabric = parseJson<{ id?: string; version?: string; provides?: string[]; depends?: unknown; breaks?: unknown }>(get('fabric.mod.json'));
  if (fabric?.id) {
    own('fabric', [fabric.id, ...(fabric.provides ?? [])], fabric.version);
    desc('fabric').depends.push(...depsOf(fabric.depends));
    desc('fabric').breaks.push(...depsOf(fabric.breaks));
  }
  const quilt = parseJson<{ quilt_loader?: { id?: string; version?: string; provides?: (string | { id: string })[]; depends?: unknown; breaks?: unknown } }>(get('quilt.mod.json'))?.quilt_loader;
  if (quilt?.id) {
    own('quilt', [quilt.id, ...(quilt.provides ?? []).map((p) => (typeof p === 'string' ? p : p.id))], quilt.version);
    desc('quilt').depends.push(...depsOf(quilt.depends));
    desc('quilt').breaks.push(...depsOf(quilt.breaks));
  }
  const forgeToml = get('META-INF/mods.toml');
  if (forgeToml) {
    const m = parseModsToml(forgeToml.toString('utf8'));
    own('forge', m.ids);
    desc('forge').depends.push(...m.depends);
    desc('forge').breaks.push(...m.breaks);
  }
  const neoToml = get('META-INF/neoforge.mods.toml');
  if (neoToml) {
    const m = parseModsToml(neoToml.toString('utf8'));
    own('neoforge', m.ids);
    desc('neoforge').depends.push(...m.depends);
    desc('neoforge').breaks.push(...m.breaks);
  }
  // mods.toml serves Forge and early NeoForge; neoforge.mods.toml is NeoForge only
  const loaders = [...new Set([...(by.fabric ? ['fabric'] : []), ...(by.quilt ? ['quilt'] : []), ...(by.forge ? ['forge', 'neoforge'] : []), ...(by.neoforge ? ['neoforge'] : [])])];

  // bundled mods (Fabric/Quilt: META-INF/jars, Forge/NeoForge: META-INF/jarjar): what they
  // provide counts for the loaders of the jar that carries them
  if (depth < 2) {
    for (const e of list) {
      const m = /^META-INF\/(jars|jarjar)\/.+\.jar$/i.exec(e.name);
      if (!m) continue;
      const inner = read(buf, e);
      if (!inner) continue;
      const im = metaOfBuffer(inner, depth + 1);
      const targets: JarLoader[] = m[1].toLowerCase() === 'jars' ? ['fabric', 'quilt'] : ['forge', 'neoforge'];
      for (const l of targets) {
        if (!by[l]) continue;
        const v = jarView(im, l);
        const src = v.known ? v : { ids: im.ids, versions: im.versions };
        by[l]!.ids.push(...src.ids);
        for (const [k, ver] of Object.entries(src.versions)) by[l]!.versions[k] ??= ver;
      }
    }
  }

  const all = Object.values(by);
  for (const d of all) d.ids = [...new Set(d.ids)];
  const versions: Record<string, string> = {};
  for (const d of all) for (const [k, v] of Object.entries(d.versions)) versions[k] ??= v;
  return {
    ids: [...new Set(all.flatMap((d) => d.ids))],
    versions,
    depends: all.flatMap((d) => d.depends),
    breaks: all.flatMap((d) => d.breaks),
    loaders,
    by,
  };
}

/** Reads a jar; a file that is not a readable jar declares nothing. */
export async function readJarMeta(file: string): Promise<JarMeta> {
  try {
    return metaOfBuffer(await fs.readFile(file));
  } catch {
    return EMPTY;
  }
}

/** One mod's jars (a main jar and add-ons) as one declaration. */
export function mergeJarMeta(metas: JarMeta[]): JarMeta {
  const by: Partial<Record<JarLoader, JarDescriptor>> = {};
  for (const m of metas) {
    for (const [l, d] of Object.entries(m.by ?? {}) as [JarLoader, JarDescriptor][]) {
      const t = (by[l] ??= { ids: [], versions: {}, depends: [], breaks: [] });
      t.ids.push(...d.ids);
      Object.assign(t.versions, { ...d.versions, ...t.versions });
      t.depends.push(...d.depends);
      t.breaks.push(...d.breaks);
    }
  }
  return {
    ids: metas.flatMap((x) => x.ids),
    versions: Object.assign({}, ...metas.map((x) => x.versions)),
    depends: metas.flatMap((x) => x.depends),
    breaks: metas.flatMap((x) => x.breaks),
    loaders: [...new Set(metas.flatMap((x) => x.loaders ?? []))],
    by: Object.keys(by).length ? by : undefined,
  };
}

export { metaOfBuffer as jarMetaOfBuffer };
