// What the game itself said about the mods the last time it ran.
//
// Every loader writes a log: which mods it loaded, which it refused and why.
// That is the one place where "is the mod really working?" has a factual
// answer. Lattice reads the logs after the game has been started with the
// current set of mods and shows, per mod, what the loader did with it.
//
// The parsers are pure (text in, facts out) and forgiving: a line they do not
// know is skipped, never an error.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GameDef, GameLogSummary, Issue } from '../../shared/types';
import { t } from '../../shared/i18n';

export interface LogFacts {
  /** which loader wrote it, as people call it */
  loader: string;
  /** names or ids of what was loaded, lower case */
  loaded: string[];
  /** what was refused, with the loader's own words */
  failed: { id: string; reason: string }[];
  /** the loader stopped the game altogether */
  fatal?: string;
  /** true when the log lists everything it loaded, so absence from the list means "not loaded" */
  complete: boolean;
}

const empty = (loader: string, complete = false): LogFacts => ({ loader, loaded: [], failed: [], complete });
const lines = (text: string) => text.split(/\r?\n/);

// ---------- Minecraft

/** Fabric and Quilt: "Loading N mods:" with the list, and "Incompatible mods found!" with the reasons. */
export function parseFabricLog(text: string): LogFacts | null {
  const quilt = /Quilt Loader/i.test(text.slice(0, 20_000));
  const fabric = /Fabric Loader|net\.fabricmc/i.test(text.slice(0, 20_000));
  if (!quilt && !fabric) return null;
  const out = empty(quilt ? 'Quilt' : 'Fabric');
  const all = lines(text);
  for (let i = 0; i < all.length; i++) {
    const line = all[i];
    if (/Loading \d+ mods?:/.test(line)) {
      out.complete = true;
      for (let j = i + 1; j < all.length; j++) {
        const l = all[j];
        // Fabric: "\t- modid 1.2.3" (bundled mods are indented below with |-- and \--)
        const f = /^\s*- ([a-z0-9_\-]+) (\S+)/i.exec(l);
        // Quilt: a table row "| 12 | Name | modid | 1.2.3 | ..."
        const q = /^\|\s*\d+\s*\|[^|]*\|\s*([a-z0-9_\-]+)\s*\|/i.exec(l);
        if (f) out.loaded.push(f[1].toLowerCase());
        else if (q) out.loaded.push(q[1].toLowerCase());
        else if (/^\s*(\||\\)--/.test(l) || /^\|[-:| ]+\|?$/.test(l) || /^\|\s*Index/i.test(l)) continue;
        else if (l.trim() === '') continue;
        else break;
      }
    }
    if (/Incompatible mods? found|Some of your mods are incompatible/i.test(line)) out.fatal = t('Загрузчик остановил игру: моды несовместимы с игрой или друг с другом.');
    // "- Mod 'Indium' (indium) 1.0 requires version 0.5 or later of mod 'Sodium' (sodium), which is missing!"
    const m = /^\s*- Mod '([^']+)' \(([a-z0-9_\-]+)\) (\S+) (.+)$/i.exec(line);
    if (m && /requires|is incompatible|conflicts|breaks|recommends/i.test(m[4]) && !/recommends/i.test(m[4])) {
      out.failed.push({ id: m[2].toLowerCase(), reason: `${m[1]} ${m[3]} ${m[4]}`.replace(/\s+/g, ' ').trim() });
    }
  }
  return out;
}

/** Forge and NeoForge: mod files found (debug level) and missing or wrong dependencies. */
export function parseForgeLog(text: string): LogFacts | null {
  if (!/MinecraftForge|net\.minecraftforge|neoforge|fml\.loading|ModLauncher/i.test(text.slice(0, 40_000))) return null;
  const out = empty(/neoforge/i.test(text.slice(0, 40_000)) ? 'NeoForge' : 'Forge');
  const all = lines(text);
  for (let i = 0; i < all.length; i++) {
    const found = /Found valid mod file (\S+\.jar) with \{([^}]*)\} mods/.exec(all[i]);
    if (found) {
      out.complete = true;
      for (const id of found[2].split(',')) if (id.trim()) out.loaded.push(id.trim().toLowerCase());
    }
    if (/Missing or unsupported mandatory dependencies/i.test(all[i])) {
      out.fatal = t('Загрузчик остановил игру: не хватает обязательных зависимостей.');
      for (let j = i + 1; j < all.length; j++) {
        const d = /Mod ID: '([^']+)', Requested by: '([^']+)', Expected range: '([^']*)', Actual version: '([^']*)'/.exec(all[j]);
        if (!d) break;
        out.failed.push({ id: d[2].toLowerCase(), reason: d[4] === '[MISSING]' ? `requires ${d[1]} ${d[3]}, which is missing` : `requires ${d[1]} ${d[3]}, but ${d[4]} is installed` });
      }
    }
  }
  return out;
}

// ---------- BepInEx

export function parseBepInExLog(text: string): LogFacts | null {
  if (!/BepInEx/i.test(text.slice(0, 4000))) return null;
  const out = empty('BepInEx', true);
  for (const line of lines(text)) {
    const ok = /\]\s*Loading \[(.+?) [^\s\]]+\]\s*$/.exec(line);
    if (ok) out.loaded.push(ok[1].toLowerCase());
    const bad = /Could not load \[(.+?) [^\s\]]+\] because (.+)$/.exec(line) ?? /Skipping \[(.+?) [^\s\]]+\] because (.+)$/.exec(line);
    if (bad && !/a newer version exists/i.test(bad[2])) out.failed.push({ id: bad[1].toLowerCase(), reason: bad[2].trim() });
  }
  return out;
}

// ---------- Stardew Valley (SMAPI)

export function parseSmapiLog(text: string): LogFacts | null {
  if (!/SMAPI/.test(text.slice(0, 4000))) return null;
  const out = empty('SMAPI');
  const body = (l: string) => l.replace(/^\[[^\]]*\]\s?/, '');
  let mode: 'loaded' | 'skipped' | null = null;
  for (const raw of lines(text)) {
    const l = body(raw);
    if (/^Loaded \d+ (mods|content packs):/.test(l)) {
      mode = 'loaded';
      out.complete = true;
      continue;
    }
    if (/^Skipped mods/.test(l)) {
      mode = 'skipped';
      continue;
    }
    if (mode === 'loaded') {
      const m = /^\s{2,}(.+?) (\d[^\s]*) by /.exec(l);
      if (m) out.loaded.push(m[1].toLowerCase());
      else if (l.trim() === '') mode = null;
      else if (!/^\s/.test(l)) mode = null;
    } else if (mode === 'skipped') {
      const m = /^\s+- (.+?) (\d[^\s]*) because (.+)$/.exec(l) ?? /^\s+- (.+?)() because (.+)$/.exec(l);
      if (m) out.failed.push({ id: m[1].toLowerCase(), reason: m[3].trim() });
      else if (/^(Found|Loaded|Launching|Detected)/.test(l)) mode = null;
    }
  }
  return out;
}

// ---------- Cyberpunk 2077

export function parseRed4extLog(text: string): LogFacts | null {
  if (!/RED4ext/i.test(text.slice(0, 4000))) return null;
  const out = empty('RED4ext', true);
  for (const line of lines(text)) {
    const ok = /\]\s*([^\][]+?) \(version: .*\) has been loaded/.exec(line);
    if (ok) out.loaded.push(ok[1].trim().toLowerCase());
    const dll = /plugin located at '.*[\\/]plugins[\\/]([^\\/']+)[\\/][^\\/']+' could not be loaded\.?(.*)$/i.exec(line);
    if (dll) out.failed.push({ id: dll[1].toLowerCase(), reason: `could not be loaded${dll[2] ? `:${dll[2]}` : ''}`.trim() });
    const inc = /\]\s*([^\][]+?) \(version: .*?\) is incompatible (.+)$/.exec(line);
    if (inc) out.failed.push({ id: inc[1].trim().toLowerCase(), reason: `is incompatible ${inc[2]}`.trim() });
  }
  return out;
}

export function parseCetLog(text: string): LogFacts | null {
  if (!/CET version|Cyber Engine Tweaks/i.test(text.slice(0, 4000))) return null;
  const out = empty('Cyber Engine Tweaks', true);
  for (const line of lines(text)) {
    const ok = /Mod (.+?) loaded! \(/.exec(line);
    if (ok) out.loaded.push(ok[1].toLowerCase());
    if (/\[error\]/i.test(line)) {
      const m = /[\\/]cyber_engine_tweaks[\\/]mods[\\/]([^\\/]+)[\\/]/i.exec(line);
      if (m && !out.failed.some((f) => f.id === m[1].toLowerCase())) out.failed.push({ id: m[1].toLowerCase(), reason: line.replace(/^\[[^\]]*\]\s*\[error\]\s*/i, '').slice(0, 220) });
    }
  }
  return out;
}

export function parseRedscriptLog(text: string): LogFacts | null {
  if (!/redscript|Compiling files|scc/i.test(text.slice(0, 4000))) return null;
  const out = empty('redscript');
  const all = lines(text);
  for (let i = 0; i < all.length; i++) {
    if (!/^\[ERROR/i.test(all[i])) continue;
    if (/compilation (has )?failed/i.test(all[i])) out.fatal = t('redscript не собрал скрипты: игра запускается без всех модов на .reds.');
    // the place of an error follows it, on the same or the next lines
    const block = all.slice(i, i + 4).join(' ');
    const m = /r6[\\/]scripts[\\/]([^\\/:\s]+)[\\/]?/i.exec(block);
    if (m && !out.failed.some((f) => f.id === m[1].toLowerCase())) out.failed.push({ id: m[1].toLowerCase(), reason: all[i].replace(/^\[ERROR[^\]]*\]\s*/i, '').slice(0, 220) });
  }
  return out;
}

// ---------- Skyrim SE and Fallout 4 (script extenders)

export function parseSkseLog(text: string): LogFacts | null {
  if (!/(SKSE64|F4SE) runtime|plugin directory/i.test(text.slice(0, 4000))) return null;
  const out = empty(/F4SE/.test(text.slice(0, 400)) ? 'F4SE' : 'SKSE', true);
  for (const line of lines(text)) {
    const p = /^plugin (.+?\.dll) \(.*?\) (.+?) \(handle \d+\)/i.exec(line.trim());
    if (p) {
      const id = p[1].toLowerCase().replace(/\.dll$/, '');
      if (/loaded correctly/i.test(p[2])) out.loaded.push(id);
      else out.failed.push({ id, reason: p[2].trim() });
    }
    const c = /couldn't load plugin .*[\\/]([^\\/]+)\.dll (.*)$/i.exec(line.trim());
    if (c) out.failed.push({ id: c[1].toLowerCase(), reason: `couldn't load ${c[2]}`.trim() });
  }
  return out;
}

// ---------- finding and reading the logs of a game

export interface ReadLog {
  file: string;
  mtime: number;
  facts: LogFacts;
}

/** logs already parsed, by file: a log is read again only when it has changed */
const parsed = new Map<string, { mtime: number; size: number; facts: LogFacts | null }>();

async function readText(file: string): Promise<{ text: string; mtime: number } | null> {
  const st = await fs.stat(file).catch(() => null);
  if (!st?.isFile()) return null;
  const MAX = 6 * 1024 * 1024;
  if (st.size <= MAX) return { text: await fs.readFile(file, 'utf8'), mtime: st.mtimeMs };
  // a huge log: the start (what was loaded) and the end (what went wrong)
  const fh = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(4 * 1024 * 1024);
    const tail = Buffer.alloc(1024 * 1024);
    await fh.read(head, 0, head.length, 0);
    await fh.read(tail, 0, tail.length, st.size - tail.length);
    return { text: `${head.toString('utf8')}\n${tail.toString('utf8')}`, mtime: st.mtimeMs };
  } finally {
    await fh.close();
  }
}

/** The newest file in a folder whose name matches. */
async function newest(dir: string, name: RegExp): Promise<string | null> {
  const list = await fs.readdir(dir).catch(() => [] as string[]);
  let best: { f: string; m: number } | null = null;
  for (const f of list) {
    if (!name.test(f)) continue;
    const st = await fs.stat(path.join(dir, f)).catch(() => null);
    if (st?.isFile() && (!best || st.mtimeMs > best.m)) best = { f, m: st.mtimeMs };
  }
  return best ? path.join(dir, best.f) : null;
}

/** Folders where Windows keeps "Documents" (it may live in OneDrive). */
function documentsDirs(home: string): string[] {
  return [path.join(home, 'Documents'), path.join(home, 'OneDrive', 'Documents'), path.join(home, 'OneDrive', 'Документы'), path.join(home, 'Документы')];
}

/** Reads every log the loaders of this game write. `home` and `appData` come from the detection environment. */
export async function readGameLogs(def: GameDef, gameDir: string, where: { home?: string; appData?: string } = {}): Promise<ReadLog[]> {
  const home = where.home ?? os.homedir();
  const appData = where.appData ?? process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const tries: { file: string | null; parse: (t: string) => LogFacts | null }[] = [];
  if (def.kind === 'minecraft') {
    tries.push({ file: path.join(gameDir, 'logs', 'latest.log'), parse: (x) => parseFabricLog(x) ?? parseForgeLog(x) });
    tries.push({ file: path.join(gameDir, 'logs', 'debug.log'), parse: parseForgeLog });
  } else if (def.kind === 'bepinex') {
    tries.push({ file: path.join(gameDir, 'BepInEx', 'LogOutput.log'), parse: parseBepInExLog });
  } else if (def.id === 'stardewvalley') {
    tries.push({ file: path.join(appData, 'StardewValley', 'ErrorLogs', 'SMAPI-latest.txt'), parse: parseSmapiLog });
  } else if (def.id === 'cyberpunk2077') {
    tries.push({ file: (await newest(path.join(gameDir, 'red4ext', 'logs'), /^red4ext.*\.log$/i)) ?? null, parse: parseRed4extLog });
    tries.push({ file: path.join(gameDir, 'bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'cyber_engine_tweaks.log'), parse: parseCetLog });
    tries.push({ file: path.join(gameDir, 'r6', 'logs', 'redscript_rCURRENT.log'), parse: parseRedscriptLog });
  } else if (def.id === 'skyrimse' || def.id === 'fallout4') {
    const [folders, name] = def.id === 'skyrimse' ? [['Skyrim Special Edition', 'Skyrim Special Edition GOG', 'Skyrim Special Edition EPIC'], 'skse64.log'] : [['Fallout4'], 'f4se.log'];
    for (const docs of documentsDirs(home)) for (const f of folders) tries.push({ file: path.join(docs, 'My Games', f, def.id === 'skyrimse' ? 'SKSE' : 'F4SE', name), parse: parseSkseLog });
  }
  const out: ReadLog[] = [];
  for (const tr of tries) {
    if (!tr.file) continue;
    const st = await fs.stat(tr.file).catch(() => null);
    if (!st?.isFile()) continue;
    let hit = parsed.get(tr.file);
    if (!hit || hit.mtime !== st.mtimeMs || hit.size !== st.size) {
      const r = await readText(tr.file).catch(() => null);
      if (!r) continue;
      hit = { mtime: st.mtimeMs, size: st.size, facts: tr.parse(r.text) };
      parsed.set(tr.file, hit);
      if (parsed.size > 40) parsed.delete(parsed.keys().next().value!);
    }
    if (hit.facts) out.push({ file: tr.file, mtime: hit.mtime, facts: hit.facts });
  }
  // Forge: debug.log carries the list, latest.log the same failures — keep the one that knows more
  if (def.kind === 'minecraft' && out.length > 1) {
    const full = out.find((l) => l.facts.complete);
    return full ? [{ ...full, facts: { ...full.facts, failed: out.flatMap((l) => l.facts.failed), fatal: out.find((l) => l.facts.fatal)?.facts.fatal } }] : [out[0]];
  }
  return out;
}

// ---------- matching what the logs say with the mods of the profile

export interface LogSubject {
  key: string;
  title: string;
  /**
   * What loaders may call this mod: mod ids, plugin names, folder names (lower
   * case). `loader` names the loader that is expected to list it; without one
   * the name only helps to find the mod a failure talks about.
   */
  names: { id: string; loader?: string }[];
}

const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '');

type NewIssue = Omit<Issue, 'id'>;

/**
 * Turns the logs of the last run into issues and a summary. Logs older than
 * `since` (the last time the mods in the game folder changed) say nothing about
 * the current set and are only mentioned.
 */
export function logFindings(logs: ReadLog[], subjects: LogSubject[], since: number): { issues: NewIssue[]; summary: GameLogSummary | null } {
  if (logs.length === 0) return { issues: [], summary: null };
  const newestLog = logs.reduce((a, b) => (a.mtime > b.mtime ? a : b));
  const fresh = logs.filter((l) => l.mtime >= since);
  const summary: GameLogSummary = {
    file: newestLog.file,
    at: new Date(newestLog.mtime).toISOString(),
    loaders: [...new Set(logs.map((l) => l.facts.loader))],
    loaded: fresh.reduce((n, l) => n + l.facts.loaded.length, 0),
    failed: fresh.reduce((n, l) => n + l.facts.failed.length, 0),
    stale: fresh.length === 0,
    fatal: fresh.find((l) => l.facts.fatal)?.facts.fatal,
  };
  const issues: NewIssue[] = [];
  if (fresh.length === 0) return { issues, summary };
  const find = (id: string) => {
    const f = flat(id);
    return (
      subjects.find((s) => s.names.some((x) => x.id === id || flat(x.id) === f)) ??
      subjects.find((s) => f.length >= 4 && (flat(s.title) === f || s.names.some((x) => flat(x.id).length >= 4 && (flat(x.id).includes(f) || f.includes(flat(x.id))))))
    );
  };
  const reported = new Set<string>();
  for (const log of fresh) {
    for (const f of log.facts.failed) {
      const s = find(f.id);
      const key = s?.key ?? `game:${f.id}`;
      if (reported.has(key)) continue;
      reported.add(key);
      issues.push({
        severity: 'error',
        code: 'not-loaded',
        subject: key,
        related: [],
        message: t('{0} не загрузил «{1}» при последнем запуске игры: {2}', log.facts.loader, s?.title ?? f.id, f.reason),
      });
    }
    if (log.facts.fatal && log.facts.failed.length === 0) {
      issues.push({ severity: 'error', code: 'not-loaded', subject: `game:${log.facts.loader}`, related: [], message: log.facts.fatal });
    }
  }
  // mods a loader should have listed and did not
  for (const log of fresh.filter((l) => l.facts.complete)) {
    const loaded = new Set(log.facts.loaded);
    const loadedFlat = new Set(log.facts.loaded.map(flat));
    const mine = subjects.filter((s) => s.names.some((n) => n.loader === log.facts.loader));
    const missing = mine.filter((s) => !reported.has(s.key) && !s.names.some((n) => n.loader === log.facts.loader && (loaded.has(n.id) || loadedFlat.has(flat(n.id)))));
    if (missing.length === 0) continue;
    // nearly everything missing means the game ran some other way (another version, another folder): said once
    if (mine.length >= 3 && missing.length > mine.length * 0.6) {
      issues.push({
        severity: 'warning',
        code: 'not-loaded',
        subject: `game:run:${log.facts.loader}`,
        related: [],
        message: t('При последнем запуске {0} не загрузил почти ни одного мода профиля ({1} из {2}). Похоже, игра запускалась не с этими модами: проверьте, какую версию или профиль выбирает лаунчер.', log.facts.loader, missing.length, mine.length),
      });
      continue;
    }
    for (const s of missing.slice(0, 25)) {
      reported.add(s.key);
      issues.push({ severity: 'warning', code: 'not-loaded', subject: s.key, related: [], message: t('«{0}» нет среди загруженных при последнем запуске игры (по журналу {1}).', s.title, log.facts.loader) });
    }
  }
  return { issues, summary };
}
