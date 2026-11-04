// Bethesda load order: reads plugin masters from the TES4 header and keeps
// plugins.txt in step with the mod order. Masters a plugin needs are links
// too — a missing one is a compatibility error, like a missing dependency.
import fs from 'node:fs/promises';
import path from 'node:path';

export const PLUGIN_EXT = /\.(esp|esm|esl)$/i;

export function isMasterFile(name: string) {
  return /\.(esm|esl)$/i.test(name);
}

/** Master files listed in a plugin's TES4 header (MAST subrecords). */
export function readMasters(buf: Buffer): string[] {
  if (buf.length < 24 || buf.toString('latin1', 0, 4) !== 'TES4') return [];
  const dataSize = buf.readUInt32LE(4);
  // Skyrim SE / Fallout 4 headers are 24 bytes, Oblivion's 20.
  const header = buf.toString('latin1', 20, 24) === 'HEDR' ? 20 : 24;
  const end = Math.min(buf.length, header + dataSize);
  const masters: string[] = [];
  let pos = header;
  let bigSize = 0;
  while (pos + 6 <= end) {
    const type = buf.toString('latin1', pos, pos + 4);
    let size = buf.readUInt16LE(pos + 4);
    if (bigSize) {
      size = bigSize;
      bigSize = 0;
    }
    const data = pos + 6;
    if (type === 'XXXX') bigSize = buf.readUInt32LE(data);
    else if (type === 'MAST') {
      const raw = buf.subarray(data, data + size);
      const zero = raw.indexOf(0);
      masters.push(raw.toString('latin1', 0, zero === -1 ? raw.length : zero));
    }
    pos = data + size;
  }
  return masters;
}

const masterCache = new Map<string, { mtime: number; masters: string[] }>();

export async function pluginMasters(file: string): Promise<string[]> {
  const st = await fs.stat(file);
  const hit = masterCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.masters;
  const fh = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(24);
    await fh.read(head, 0, 24, 0);
    const want = Math.min(st.size, 24 + (head.toString('latin1', 0, 4) === 'TES4' ? head.readUInt32LE(4) : 0));
    const buf = Buffer.alloc(want);
    await fh.read(buf, 0, want, 0);
    const masters = readMasters(buf);
    masterCache.set(file, { mtime: st.mtimeMs, masters });
    return masters;
  } finally {
    await fh.close();
  }
}

export interface PluginLine {
  name: string;
  enabled: boolean;
}

export function parsePluginsTxt(text: string): PluginLine[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => (l.startsWith('*') ? { name: l.slice(1), enabled: true } : { name: l, enabled: false }));
}

/**
 * New plugins.txt: entries Lattice does not manage keep their place and state;
 * managed plugins follow in mod order, all enabled. Masters always come first.
 */
export function buildPluginsTxt(existing: PluginLine[], managed: string[], previouslyManaged: string[]): string {
  const low = (s: string) => s.toLowerCase();
  const managedSet = new Set(managed.map(low));
  const dropped = new Set(previouslyManaged.map(low));
  const kept = existing.filter((e) => !managedSet.has(low(e.name)) && !dropped.has(low(e.name)));
  const all: PluginLine[] = [...kept, ...managed.map((name) => ({ name, enabled: true }))];
  const ordered = [...all.filter((p) => isMasterFile(p.name)), ...all.filter((p) => !isMasterFile(p.name))];
  return ['# Этот файл ведёт Lattice: порядок плагинов следует порядку модов и правилам «до/после».', ...ordered.map((p) => `${p.enabled ? '*' : ''}${p.name}`)].join('\r\n') + '\r\n';
}

export function pluginsTxtPath(folder: string): string {
  const base = process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local');
  return path.join(base, folder, 'plugins.txt');
}

interface ManagedState {
  managed: string[];
}

/** Writes plugins.txt, keeping one backup of the original made before Lattice touched it. */
export async function writePluginsTxt(target: string, stateDir: string, managed: string[]): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
  const statePath = path.join(stateDir, 'plugins-managed.json');
  const backup = path.join(stateDir, 'plugins.txt.orig');
  const prev = (await fs.readFile(statePath, 'utf8').then(JSON.parse).catch(() => ({ managed: [] }))) as ManagedState;
  const current = await fs.readFile(target, 'utf8').catch(() => '');
  try {
    await fs.access(backup);
  } catch {
    await fs.writeFile(backup, current);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buildPluginsTxt(parsePluginsTxt(current), managed, prev.managed));
  await fs.writeFile(statePath, JSON.stringify({ managed } satisfies ManagedState));
}

/** Puts the original plugins.txt back (used when the game folder is purged). */
export async function restorePluginsTxt(target: string, stateDir: string): Promise<void> {
  const backup = path.join(stateDir, 'plugins.txt.orig');
  try {
    const orig = await fs.readFile(backup, 'utf8');
    if (orig) await fs.writeFile(target, orig);
    else await fs.rm(target, { force: true });
    await fs.rm(backup, { force: true });
  } catch {
    /* nothing was changed */
  }
  await fs.rm(path.join(stateDir, 'plugins-managed.json'), { force: true });
}
