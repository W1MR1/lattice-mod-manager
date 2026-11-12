// Archive access for zip (yauzl), 7z (7-Zip from 7zip-bin) and rar (unrar
// compiled to WebAssembly). 7z and rar are unpacked into a private temporary
// folder first; every path is checked before anything reaches its target.
import { spawn } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { path7za } from '7zip-bin';
import yauzl from 'yauzl';
import { t } from '../../shared/i18n';

export type ArchiveKind = 'zip' | '7z' | 'rar';

export function archiveKind(name: string): ArchiveKind | null {
  if (/\.(zip|mrpack)$/i.test(name)) return 'zip';
  if (/\.7z$/i.test(name)) return '7z';
  if (/\.rar$/i.test(name)) return 'rar';
  return null;
}

/** Normalizes an archive entry name and refuses anything escaping the target (zip-slip). */
export function safeRel(name: string): string | null {
  const n = path.posix.normalize(name.replace(/\\/g, '/')).replace(/^\/+/, '');
  if (!n || n === '.' || n === '..' || n.startsWith('../') || n.includes('/../') || /^[a-zA-Z]:/.test(n)) return null;
  return n;
}

// ---------- zip

export function listZip(file: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error(t('Не удалось открыть архив')));
      const names: string[] = [];
      zip.on('entry', (e: yauzl.Entry) => {
        if (!/\/$/.test(e.fileName)) names.push(e.fileName);
        zip.readEntry();
      });
      zip.on('end', () => resolve(names));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

/** Extracts entries; `map` returns the relative target path or null to skip. */
export function extractZip(file: string, dest: string, map: (name: string) => string | null): Promise<number> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error(t('Не удалось открыть архив')));
      let count = 0;
      zip.on('error', reject);
      zip.on('end', () => resolve(count));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName)) return zip.readEntry();
        const rel = safeRel(entry.fileName);
        const target = rel ? map(rel) : null;
        const safeTarget = target ? safeRel(target) : null;
        if (!safeTarget) return zip.readEntry();
        const out = path.join(dest, safeTarget);
        fs.mkdir(path.dirname(out), { recursive: true })
          .then(
            () =>
              new Promise<void>((res, rej) =>
                zip.openReadStream(entry, (e2, rs) => {
                  if (e2 || !rs) return rej(e2 ?? new Error('read'));
                  pipeline(rs, createWriteStream(out)).then(res, rej);
                }),
              ),
          )
          .then(() => {
            count++;
            zip.readEntry();
          })
          .catch(reject);
      });
      zip.readEntry();
    });
  });
}

// ---------- 7z

let sevenZipPath: string | null = null;

export function sevenZip(): string {
  if (sevenZipPath) return sevenZipPath;
  // inside a packaged app the binary lives next to the asar, not in it
  let p = path7za.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  // Windows cannot start a process from a path of 260+ characters, long paths or not:
  // run a copy from a short folder instead when the app sits deep in the tree
  if (process.platform === 'win32' && p.length >= 240) {
    const size = statSync(p).size;
    const short = path.join(os.tmpdir(), 'lattice-7za', `7za-${size}.exe`);
    if (!existsSync(short) || statSync(short).size !== size) {
      mkdirSync(path.dirname(short), { recursive: true });
      copyFileSync(p, short);
    }
    p = short;
  }
  sevenZipPath = p;
  return p;
}

function run7z(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(sevenZip(), args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`7-Zip: ${err.trim() || t('код {0}', code)}`))));
  });
}

async function list7z(file: string): Promise<string[]> {
  const out = await run7z(['l', '-ba', '-slt', '-sccUTF-8', file]);
  const names: string[] = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    const p = /^Path = (.+)$/m.exec(block)?.[1];
    const folder = /^Folder = \+$/m.test(block) || /^Attributes = D/m.test(block);
    if (p && !folder) names.push(p.trim().replace(/\\/g, '/'));
  }
  return names;
}

// ---------- rar

async function rarExtractor(file: string, targetPath: string) {
  const { createExtractorFromFile } = await import('node-unrar-js');
  return createExtractorFromFile({ filepath: file, targetPath });
}

async function listRar(file: string): Promise<string[]> {
  const ex = await rarExtractor(file, os.tmpdir());
  return [...ex.getFileList().fileHeaders].filter((h) => !h.flags.directory).map((h) => h.name.replace(/\\/g, '/'));
}

// ---------- common

export async function listArchive(file: string): Promise<string[]> {
  const kind = archiveKind(file);
  if (kind === '7z') return list7z(file);
  if (kind === 'rar') return listRar(file);
  return listZip(file);
}

/** Unpacks the whole archive (or only `only`) into `dir`, refusing unsafe paths. */
async function unpackAll(file: string, dir: string, only?: string[]): Promise<void> {
  const kind = archiveKind(file);
  if (kind === '7z') {
    const include = only?.map((n) => `-i!${n}`) ?? [];
    await run7z(['x', '-y', '-snl-', `-o${dir}`, ...include, file]);
    return;
  }
  if (kind === 'rar') {
    const ex = await rarExtractor(file, dir);
    const res = ex.extract({
      files: (h) => !h.flags.directory && safeRel(h.name) !== null && (!only || only.includes(h.name.replace(/\\/g, '/'))),
    });
    for (const f of res.files) void f; // the generator extracts as it is consumed
    return;
  }
  await extractZip(file, dir, (n) => (!only || only.includes(n) ? n : null));
}

/** Regular files under `root` as posix paths. Symlinks and special files are ignored. */
export async function listTree(root: string): Promise<string[]> {
  const out: string[] = [];
  const rec = async (d: string, rel: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await rec(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  await rec(root, '');
  return out;
}

export async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-x-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function moveFile(src: string, dst: string) {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.rm(dst, { force: true });
  try {
    await fs.rename(src, dst);
  } catch {
    await fs.copyFile(src, dst);
  }
}

/** Extracts any supported archive; `map` returns the relative target path or null to skip. */
export async function extractArchive(file: string, dest: string, map: (name: string) => string | null): Promise<number> {
  if (archiveKind(file) === 'zip') return extractZip(file, dest, map);
  return withTemp(async (tmp) => {
    await unpackAll(file, tmp);
    let count = 0;
    for (const rel of await listTree(tmp)) {
      const safe = safeRel(rel);
      const target = safe ? map(safe) : null;
      const safeTarget = target ? safeRel(target) : null;
      if (!safeTarget) continue;
      await moveFile(path.join(tmp, rel), path.join(dest, safeTarget));
      count++;
    }
    return count;
  });
}

/** Unpacks the whole archive into `dir` (a fresh folder the caller owns). */
export async function unpackTo(file: string, dir: string): Promise<void> {
  if (archiveKind(file) === 'zip') {
    await extractZip(file, dir, (n) => n);
    return;
  }
  await withTemp(async (tmp) => {
    await unpackAll(file, tmp);
    for (const rel of await listTree(tmp)) if (safeRel(rel)) await moveFile(path.join(tmp, rel), path.join(dir, rel));
  });
}

/** Reads one entry into memory, or null when it is absent. */
export async function readEntry(file: string, name: string): Promise<Buffer | null> {
  if (safeRel(name) === null) return null; // an entry that points outside is never followed
  return withTemp(async (tmp) => {
    await unpackAll(file, tmp, [name]);
    try {
      return await fs.readFile(path.join(tmp, name));
    } catch {
      return null;
    }
  });
}
