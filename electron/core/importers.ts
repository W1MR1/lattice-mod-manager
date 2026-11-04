// Mods installed by other managers, read from their own folders:
//  - Vortex: the staging folder ("mods") and vortex.deployment*.json in the game
//    folder, which names the staging folder and which mods are deployed now;
//  - Mod Organizer 2: instances, mods/<name>/meta.ini (Nexus ids) and
//    profiles/<name>/modlist.txt (enabled mods and priority);
//  - r2modman / Thunderstore Mod Manager: profiles/<name>/mods.yml.
// Nothing here writes to those folders.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GameDef } from '../../shared/types';
import { GAME_DEFS } from './games';
import type { DetectEnv } from './detect';

export type Manager = 'vortex' | 'mo2' | 'r2modman';

export interface ImportMod {
  name: string;
  /** the folder name the other manager uses (Vortex derives it from the archive name) */
  folder?: string;
  /** folder with the mod's files */
  dir?: string;
  /** where those files go, relative to Lattice's deploy root for the game ('' = the root itself) */
  prefix?: string;
  enabled: boolean;
  /** higher wins a file both mods have */
  priority: number;
  /** uploaded: the file's upload time (seconds), which Vortex keeps at the end of the folder name */
  nexus?: { modId: number; fileId?: number; version?: string; uploaded?: number };
  thunderstore?: { fullName: string; version: string };
  /** why the mod cannot be taken over as it is */
  problem?: string;
}

export interface ImportProfile {
  id: string;
  name: string;
  mods: ImportMod[];
  /** relPath (lower case) -> winning mod name, as the other manager deployed it */
  winners?: Record<string, string>;
}

export interface ImportSource {
  id: string;
  manager: Manager;
  defId: string;
  /** what to show: the manager and where its files are */
  path: string;
  profiles: ImportProfile[];
  /** files of this manager are deployed into the game folder now (Vortex): they must be purged first */
  deployedFiles?: number;
}

// ---------- helpers

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function dirs(p: string): Promise<string[]> {
  const list = await fs.readdir(p, { withFileTypes: true }).catch(() => []);
  return list.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function readText(p: string) {
  return (await fs.readFile(p, 'utf8').catch(() => '')).replace(/^﻿/, '');
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A Lattice game for a name another manager uses ("skyrimse", "Skyrim Special Edition", "LethalCompany"…). */
export function defForName(name: string): GameDef | undefined {
  const n = norm(name);
  const aliases: Record<string, string> = { skyrimspecialedition: 'skyrimse', skyrimse: 'skyrimse', fallout4: 'fallout4', cyberpunk2077: 'cyberpunk2077', stardewvalley: 'stardewvalley' };
  if (aliases[n]) return GAME_DEFS.find((d) => d.id === aliases[n]);
  return GAME_DEFS.find((d) => norm(d.id) === n || norm(d.name) === n || (d.nexusDomain && norm(d.nexusDomain) === n));
}

/**
 * Nexus ids from a Vortex folder or archive name: "Cyber Engine Tweaks-107-1-38-1-1735000000"
 * (name, mod id, version with dashes, upload time), maybe with ".1" for a second copy.
 */
export function parseNexusArchiveName(name: string): { title: string; modId: number; version: string; uploaded: number } | null {
  const m = /^(.*?)-(\d+)-(\d[\w]*(?:-[\w]+)*?)-(\d{9,11})(?:\.\d+)?(?:\.(?:zip|7z|rar))?$/i.exec(name.trim());
  if (!m) return null;
  return { title: m[1].trim(), modId: Number(m[2]), version: m[3].replace(/-/g, '.'), uploaded: Number(m[4]) };
}

// ---------- Vortex

interface VortexManifest {
  stagingPath?: string;
  targetPath?: string;
  gameId?: string;
  files?: { relPath: string; source: string; target?: string }[];
}

async function manifestsIn(dir: string): Promise<{ file: string; m: VortexManifest }[]> {
  const out: { file: string; m: VortexManifest }[] = [];
  for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!/^vortex\.deployment(\.[\w-]+)?\.json$/i.test(f)) continue;
    try {
      out.push({ file: path.join(dir, f), m: JSON.parse(await readText(path.join(dir, f))) as VortexManifest });
    } catch {
      /* unreadable manifest */
    }
  }
  return out;
}

/** Folders of a game copy where Vortex may deploy: the root and the usual mod folders. */
function deployCandidates(gameDir: string, def: GameDef) {
  const subs = ['', def.deployDir, 'Data', 'Mods', 'BepInEx', 'BepInEx/plugins', 'BepInEx/patchers', 'archive/pc/mod', 'r6/scripts', 'red4ext/plugins'];
  return [...new Set(subs)].map((s) => path.join(gameDir, s));
}

export async function vortexSources(env: DetectEnv, gameDirs: { defId: string; path: string }[]): Promise<ImportSource[]> {
  // staging folder -> what we know about it
  const found = new Map<string, { def: GameDef; staging: string; prefixOf: Map<string, string>; deployed: Set<string>; winners: Record<string, string>; files: number; gameDir?: string }>();
  const keyOf = (p: string) => path.resolve(p).toLowerCase();

  for (const g of gameDirs) {
    const def = GAME_DEFS.find((d) => d.id === g.defId);
    if (!def || def.kind === 'minecraft') continue;
    const root = path.join(g.path, def.deployDir);
    for (const dir of deployCandidates(g.path, def)) {
      for (const { m } of await manifestsIn(dir)) {
        if (!m.stagingPath) continue;
        const k = keyOf(m.stagingPath);
        const rec = found.get(k) ?? { def, staging: m.stagingPath, prefixOf: new Map<string, string>(), deployed: new Set<string>(), winners: {} as Record<string, string>, files: 0, gameDir: g.path };
        const target = m.targetPath ?? dir;
        for (const f of m.files ?? []) {
          rec.deployed.add(f.source);
          rec.files++;
          const at = path.join(target, f.target ?? '');
          const prefix = path.relative(root, at).replace(/\\/g, '/');
          if (!rec.prefixOf.has(f.source)) rec.prefixOf.set(f.source, prefix);
          rec.winners[path.posix.join(prefix, f.relPath.replace(/\\/g, '/')).toLowerCase()] = f.source;
        }
        found.set(k, rec);
      }
    }
  }
  // the default staging folders, for games Vortex has not deployed (or purged)
  for (const def of GAME_DEFS) {
    if (def.kind === 'minecraft') continue;
    for (const id of new Set([def.id, def.id.replace(/-/g, ''), def.nexusDomain].filter(Boolean) as string[])) {
      const staging = path.join(env.appData, 'Vortex', id, 'mods');
      if (!found.has(keyOf(staging)) && (await exists(staging))) {
        found.set(keyOf(staging), { def, staging, prefixOf: new Map<string, string>(), deployed: new Set<string>(), winners: {} as Record<string, string>, files: 0 });
      }
    }
  }

  const out: ImportSource[] = [];
  for (const rec of found.values()) {
    const names = (await dirs(rec.staging)).filter((n) => !n.startsWith('__') && !/\.installing$/i.test(n));
    if (!names.length) continue;
    // a mod Vortex has not deployed goes where most of its mods go
    const counts = new Map<string, number>();
    for (const p of rec.prefixOf.values()) counts.set(p, (counts.get(p) ?? 0) + 1);
    const usual = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const mods: ImportMod[] = names.map((n) => {
      const prefix = rec.prefixOf.get(n) ?? usual;
      const ids = parseNexusArchiveName(n);
      return {
        name: ids?.title || n,
        dir: path.join(rec.staging, n),
        prefix,
        enabled: rec.deployed.size ? rec.deployed.has(n) : true,
        priority: 0,
        nexus: ids ? { modId: ids.modId, version: ids.version, uploaded: ids.uploaded } : undefined,
        problem: prefix.startsWith('..') ? 'outside' : undefined,
        folder: n,
      };
    });
    const profiles: ImportProfile[] = [];
    if (rec.deployed.size) profiles.push({ id: 'deployed', name: 'deployed', mods: mods.filter((m) => m.enabled), winners: rec.winners });
    profiles.push({ id: 'all', name: 'all', mods: mods.map((m) => ({ ...m, enabled: true })), winners: rec.winners });
    out.push({ id: `vortex:${keyOf(rec.staging)}`, manager: 'vortex', defId: rec.def.id, path: rec.staging, profiles, deployedFiles: rec.files });
  }
  return out;
}

// ---------- Mod Organizer 2

/** ModOrganizer.ini values: @ByteArray(...) wrappers and doubled backslashes removed. */
function iniValue(v?: string) {
  if (!v) return undefined;
  const m = /^@ByteArray\((.*)\)$/.exec(v.trim());
  return (m ? m[1] : v.trim()).replace(/\\\\/g, '\\');
}

async function readIni(file: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let section = '';
  for (const line of (await readText(file)).split(/\r?\n/)) {
    const s = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (s) {
      section = s[1];
      continue;
    }
    const m = /^\s*([^=;#]+?)\s*=\s*(.*)$/.exec(line);
    if (m) out[`${section}/${m[1]}`] = m[2];
  }
  return out;
}

async function mo2Instance(root: string): Promise<ImportSource | null> {
  const ini = await readIni(path.join(root, 'ModOrganizer.ini'));
  const def = defForName(iniValue(ini['General/gameName']) ?? '');
  if (!def) return null;
  const base = iniValue(ini['Settings/base_directory']) ?? root;
  const resolveDir = (v: string | undefined, fallback: string) => (v ? path.resolve(base, v.replace(/%BASE_DIR%/gi, base)) : path.join(base, fallback));
  const modsDir = resolveDir(iniValue(ini['Settings/mod_directory']), 'mods');
  const profilesDir = resolveDir(iniValue(ini['Settings/profiles_directory']), 'profiles');
  const profiles: ImportProfile[] = [];
  for (const prof of await dirs(profilesDir)) {
    const lines = (await readText(path.join(profilesDir, prof, 'modlist.txt'))).split(/\r?\n/).filter((l) => /^[+-]/.test(l));
    const mods: ImportMod[] = [];
    // modlist.txt lists the highest priority first
    for (let i = 0; i < lines.length; i++) {
      const name = lines[i].slice(1).trim();
      if (!name || /_separator$/i.test(name)) continue;
      const dir = path.join(modsDir, name);
      const meta = await readIni(path.join(dir, 'meta.ini'));
      const modId = Number(meta['General/modid']) || undefined;
      const fileId = Number(meta['installedFiles/1\\fileid']) || undefined;
      const hasRoot = await exists(path.join(dir, 'Root'));
      mods.push({
        name,
        dir,
        prefix: '',
        enabled: lines[i][0] === '+',
        priority: lines.length - i,
        nexus: modId ? { modId, fileId, version: iniValue(meta['General/version']) } : undefined,
        problem: hasRoot && def.deployDir ? 'root' : undefined,
      });
    }
    if (mods.length) profiles.push({ id: prof, name: prof, mods });
  }
  return profiles.length ? { id: `mo2:${path.resolve(root).toLowerCase()}`, manager: 'mo2', defId: def.id, path: root, profiles } : null;
}

export async function mo2Sources(env: DetectEnv): Promise<ImportSource[]> {
  const roots = new Set<string>();
  const global = path.join(env.localAppData, 'ModOrganizer');
  for (const d of await dirs(global)) if (await exists(path.join(global, d, 'ModOrganizer.ini'))) roots.add(path.join(global, d));
  // portable installs found through their shortcuts
  if (env.readShortcut) {
    for (const r of [path.join(env.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), path.join(env.home, 'Desktop')]) {
      for (const f of await fs.readdir(r, { recursive: true }).catch(() => [] as string[])) {
        if (!/mod ?organizer.*\.lnk$/i.test(String(f))) continue;
        let target: string | null = null;
        try {
          target = env.readShortcut(path.join(r, String(f)));
        } catch {
          target = null;
        }
        if (target && (await exists(path.join(path.dirname(target), 'ModOrganizer.ini')))) roots.add(path.dirname(target));
      }
    }
  }
  const out: ImportSource[] = [];
  for (const r of roots) {
    const s = await mo2Instance(r).catch(() => null);
    if (s) out.push(s);
  }
  return out;
}

// ---------- r2modman and Thunderstore Mod Manager

/** The entries of mods.yml, enough of the YAML to read names, versions and switches. */
export function parseModsYml(text: string): { name: string; version: string; enabled: boolean }[] {
  const out: { name: string; version: string; enabled: boolean }[] = [];
  for (const block of text.split(/^- /m).slice(1)) {
    const name = /^\s*name:\s*['"]?([^'"\r\n]+)['"]?\s*$/m.exec(block)?.[1]?.trim();
    const major = /^\s+major:\s*(\d+)/m.exec(block)?.[1];
    const minor = /^\s+minor:\s*(\d+)/m.exec(block)?.[1];
    const patch = /^\s+patch:\s*(\d+)/m.exec(block)?.[1];
    if (!name || major === undefined) continue;
    out.push({ name, version: `${major}.${minor ?? 0}.${patch ?? 0}`, enabled: !/^\s*enabled:\s*false/m.test(block) });
  }
  return out;
}

export async function r2Sources(env: DetectEnv): Promise<ImportSource[]> {
  const out: ImportSource[] = [];
  for (const base of [path.join(env.appData, 'r2modmanPlus-local'), path.join(env.appData, 'Thunderstore Mod Manager', 'DataFolder')]) {
    for (const game of await dirs(base)) {
      const def = defForName(game);
      if (!def || def.kind !== 'bepinex') continue;
      const profiles: ImportProfile[] = [];
      for (const prof of await dirs(path.join(base, game, 'profiles'))) {
        const list = parseModsYml(await readText(path.join(base, game, 'profiles', prof, 'mods.yml')));
        if (!list.length) continue;
        profiles.push({
          id: prof,
          name: prof,
          mods: list.map((m, i) => ({ name: m.name, enabled: m.enabled, priority: i, thunderstore: { fullName: m.name, version: m.version } })),
        });
      }
      if (profiles.length) out.push({ id: `r2:${path.join(base, game).toLowerCase()}`, manager: 'r2modman', defId: def.id, path: path.join(base, game), profiles });
    }
  }
  return out;
}

export async function scanManagers(env: DetectEnv, gameDirs: { defId: string; path: string }[]): Promise<ImportSource[]> {
  const [v, m, r] = await Promise.all([vortexSources(env, gameDirs).catch(() => []), mo2Sources(env).catch(() => []), r2Sources(env).catch(() => [])]);
  return [...v, ...m, ...r];
}

/** Files Vortex has deployed into a game copy now (they have to be purged in Vortex before Lattice deploys). */
export async function vortexDeployedFiles(gameDir: string, def: GameDef): Promise<number> {
  let n = 0;
  for (const dir of deployCandidates(gameDir, def)) for (const { m } of await manifestsIn(dir)) n += m.files?.length ?? 0;
  return n;
}
