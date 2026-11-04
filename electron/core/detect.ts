// Where games and their launchers really keep their files. A game may be a
// Steam, GOG, Epic or Xbox copy; Minecraft may be run by the official launcher,
// Prism, MultiMC, Legacy Launcher, TLauncher, CurseForge, Modrinth App or
// ATLauncher, each with its own folders. Every candidate is checked on disk.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DetectedGame, GameDef, GameStore, InstallInfo, McLauncher } from '../../shared/types';
import { GAME_DEFS, steamLibraries } from './games';

export interface DetectEnv {
  appData: string;
  localAppData: string;
  home: string;
  programData: string;
  /** Program Files folders */
  programFiles: string[];
  /** drive roots searched for XboxGames */
  drives: string[];
  steamLibraries(): Promise<string[]>;
  gogPaths(): Promise<string[]>;
  /** target of a Windows .lnk file (Electron's shell.readShortcutLink in the app) */
  readShortcut?(lnk: string): string | null;
}

export function systemEnv(readShortcut?: (lnk: string) => string | null): DetectEnv {
  const home = os.homedir();
  return {
    home,
    appData: process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'),
    localAppData: process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'),
    programData: process.env.ProgramData ?? 'C:\\ProgramData',
    programFiles: [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[],
    drives: 'CDEFGHIJ'.split('').map((d) => `${d}:\\`),
    steamLibraries,
    gogPaths: gogRegistryPaths,
    readShortcut,
  };
}

const LAUNCHER_NAME: Record<McLauncher, string> = {
  official: 'Minecraft Launcher',
  prism: 'Prism Launcher',
  multimc: 'MultiMC',
  legacy: 'Legacy Launcher',
  tlauncher: 'TLauncher',
  curseforge: 'CurseForge',
  modrinth: 'Modrinth App',
  atlauncher: 'ATLauncher',
  other: '',
};

export const launcherName = (l?: McLauncher) => (l ? LAUNCHER_NAME[l] : '');

// ---------- small helpers

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p: string) {
  return (await fs.stat(p).catch(() => null))?.isDirectory() ?? false;
}

async function dirs(p: string): Promise<string[]> {
  const list = await fs.readdir(p, { withFileTypes: true }).catch(() => []);
  return list.filter((e) => e.isDirectory()).map((e) => path.join(p, e.name));
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse((await fs.readFile(p, 'utf8')).replace(/^\uFEFF/, '')) as T;
  } catch {
    return null;
  }
}

/** key=value files: Java .properties and the INI-like .cfg of MultiMC and Prism. */
async function readProps(p: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const text = await fs.readFile(p, 'utf8').catch(() => '');
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([^#!;[\s][^=:]*?)\s*[=:]\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/\\(.)/g, '$1').trim();
  }
  return out;
}

export const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function gogRegistryPaths(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', '/s', '/v', 'path'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      resolve([...stdout.matchAll(/^\s+path\s+REG_SZ\s+(.+)$/gim)].map((m) => m[1].trim()));
    });
  });
}

// ---------- Minecraft versions

/** Game version and loader from a launcher version id or folder name. */
export function parseVersionId(id?: string): { gameVersion?: string; loader?: string } {
  if (!id) return {};
  let m = /^fabric-loader-[\w.+-]+?-(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)$/i.exec(id);
  if (m) return { loader: 'fabric', gameVersion: m[1] };
  m = /^quilt-loader-[\w.+-]+?-(\d+\.\d+(?:\.\d+)?)$/i.exec(id);
  if (m) return { loader: 'quilt', gameVersion: m[1] };
  m = /^(\d+\.\d+(?:\.\d+)?)-forge/i.exec(id);
  if (m) return { loader: 'forge', gameVersion: m[1] };
  m = /^neoforge-(\d+)\.(\d+)\./i.exec(id);
  if (m) return { loader: 'neoforge', gameVersion: m[2] === '0' ? `1.${m[1]}` : `1.${m[1]}.${m[2]}` };
  m = /^(\d+\.\d+(?:\.\d+)?)$/.exec(id);
  if (m) return { gameVersion: m[1] };
  m = /(fabric|quilt|neoforge|forge)[\s_-]*(1\.\d+(?:\.\d+)?)/i.exec(id);
  if (m) return { loader: m[1].toLowerCase(), gameVersion: m[2] };
  m = /\b(1\.\d+(?:\.\d+)?)\b/.exec(id);
  return m ? { gameVersion: m[1] } : {};
}

type McCopy = Omit<DetectedGame, 'defId'>;

/** A folder the game itself runs in (versions, mods or saves inside). */
async function looksLikeGameDir(p: string) {
  for (const sub of ['versions', 'mods', 'saves', 'options.txt']) if (await exists(path.join(p, sub))) return true;
  return false;
}

/** Prism and MultiMC keep the game in "minecraft" unless only ".minecraft" exists. */
async function mmcGameRoot(instance: string) {
  const dot = path.join(instance, '.minecraft');
  const plain = path.join(instance, 'minecraft');
  if ((await exists(dot)) && !(await exists(plain))) return dot;
  return plain;
}

const MMC_LOADERS: Record<string, string> = {
  'net.fabricmc.fabric-loader': 'fabric',
  'org.quiltmc.quilt-loader': 'quilt',
  'net.minecraftforge': 'forge',
  'net.neoforged': 'neoforge',
};

async function mmcInstances(root: string, launcher: 'prism' | 'multimc', exe?: string): Promise<McCopy[]> {
  const cfg = await readProps(path.join(root, launcher === 'prism' ? 'prismlauncher.cfg' : 'multimc.cfg'));
  let instDir = cfg.InstanceDir || 'instances';
  if (!path.isAbsolute(instDir)) instDir = path.join(root, instDir);
  const out: McCopy[] = [];
  for (const dir of await dirs(instDir)) {
    if (!(await exists(path.join(dir, 'instance.cfg')))) continue;
    const ini = await readProps(path.join(dir, 'instance.cfg'));
    const pack = await readJson<{ components?: { uid: string; version?: string }[] }>(path.join(dir, 'mmc-pack.json'));
    const comps = pack?.components ?? [];
    const loader = comps.map((c) => MMC_LOADERS[c.uid]).find(Boolean);
    out.push({
      path: await mmcGameRoot(dir),
      via: launcher,
      label: ini.name || path.basename(dir),
      gameVersion: comps.find((c) => c.uid === 'net.minecraft')?.version,
      loader,
      install: { launcher, instanceId: path.basename(dir), launcherRoot: root, launcherExe: exe },
    });
  }
  return out;
}

/** Folders named in a launcher's .properties file that hold a game. */
async function propsGameDirs(file: string): Promise<string[]> {
  const props = await readProps(file);
  const out: string[] = [];
  for (const [k, v] of Object.entries(props)) {
    if (!/dir|path/i.test(k) || !v || !path.isAbsolute(v)) continue;
    if ((await isDir(v)) && (await looksLikeGameDir(v))) out.push(path.resolve(v));
  }
  return out;
}

/** A game folder plus the per-version folders a launcher keeps under home/. */
async function withHomeFolders(root: string, launcher: McLauncher, exe: string | undefined, label: string): Promise<McCopy[]> {
  const out: McCopy[] = [{ path: root, via: launcher, label, install: { launcher, launcherRoot: root, launcherExe: exe } }];
  for (const dir of await dirs(path.join(root, 'home'))) {
    out.push({
      path: dir,
      via: launcher,
      label: path.basename(dir),
      hint: 'home',
      ...parseVersionId(path.basename(dir)),
      install: { launcher, launcherRoot: root, launcherExe: exe },
    });
  }
  return out;
}

const SHORTCUTS: [McLauncher, RegExp][] = [
  ['prism', /prism\s*launcher/i],
  ['multimc', /multimc/i],
  ['legacy', /legacy\s*launcher/i],
  ['tlauncher', /^tlauncher/i],
  ['curseforge', /curseforge/i],
  ['modrinth', /modrinth/i],
  ['atlauncher', /atlauncher/i],
  ['official', /^minecraft(\s*launcher)?$/i],
];

/** Launcher executables found through Start menu and desktop shortcuts. */
async function launcherShortcuts(env: DetectEnv): Promise<Partial<Record<McLauncher, string>>> {
  const found: Partial<Record<McLauncher, string>> = {};
  if (!env.readShortcut) return found;
  const roots = [
    path.join(env.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(env.programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(env.home, 'Desktop'),
    path.join(env.home, 'OneDrive', 'Desktop'),
    'C:\\Users\\Public\\Desktop',
  ];
  const visit = async (dir: string, depth: number) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth > 0) await visit(p, depth - 1);
      if (!e.isFile() || !/\.lnk$/i.test(e.name)) continue;
      const name = e.name.replace(/\.lnk$/i, '');
      const hit = SHORTCUTS.find(([, re]) => re.test(name));
      if (!hit || found[hit[0]]) continue;
      let target: string | null = null;
      try {
        target = env.readShortcut!(p);
      } catch {
        target = null;
      }
      if (target && /\.exe$/i.test(target) && (await exists(target))) found[hit[0]] = target;
    }
  };
  for (const r of roots) await visit(r, 2);
  return found;
}

async function firstExisting(list: string[]) {
  for (const p of list) if (await exists(p)) return p;
  return undefined;
}

/** Every Minecraft folder a launcher on this computer runs the game from. */
export async function detectMinecraft(env: DetectEnv, officialExe?: string): Promise<McCopy[]> {
  const exe = await launcherShortcuts(env);
  const out: McCopy[] = [];

  // official launcher (and TLauncher, which shares .minecraft)
  const dotMc = path.join(env.appData, '.minecraft');
  if (await isDir(dotMc)) {
    const tl = await exists(path.join(dotMc, 'TlauncherProfiles.json'));
    const official = officialExe ?? exe.official;
    const launcher: McLauncher = tl && !official ? 'tlauncher' : 'official';
    out.push({ path: dotMc, via: launcher, label: '.minecraft', install: { launcher, launcherRoot: dotMc, launcherExe: launcher === 'official' ? official : exe.tlauncher } });
    const doc = await readJson<{ profiles?: Record<string, { name?: string; gameDir?: string; lastVersionId?: string }> }>(path.join(dotMc, 'launcher_profiles.json'));
    for (const p of Object.values(doc?.profiles ?? {})) {
      if (!p.gameDir || !path.isAbsolute(p.gameDir) || samePath(p.gameDir, dotMc) || !(await isDir(p.gameDir))) continue;
      out.push({ path: path.resolve(p.gameDir), via: 'official', label: p.name || path.basename(p.gameDir), ...parseVersionId(p.lastVersionId), install: { launcher: 'official', launcherRoot: dotMc, launcherExe: official } });
    }
  }

  // TLauncher with its own game folder
  for (const dir of await propsGameDirs(path.join(env.appData, '.tlauncher', 'tlauncher-2.0.properties'))) {
    if (!samePath(dir, dotMc)) out.push(...(await withHomeFolders(dir, 'tlauncher', exe.tlauncher, 'TLauncher')));
  }

  // Legacy Launcher: its own folder (by default under .tlauncher\legacy), per-version folders under home/
  const legacyRoots = new Set<string>();
  const legacyDefault = path.join(env.appData, '.tlauncher', 'legacy', 'Minecraft');
  for (const cfg of [path.join(env.appData, '.tlauncher', 'legacy.properties'), path.join(legacyDefault, 'tl.properties'), path.join(env.appData, '.tlauncher', 'legacy', 'tl.properties')]) {
    for (const d of await propsGameDirs(cfg)) legacyRoots.add(d);
  }
  if ((await isDir(legacyDefault)) && (await looksLikeGameDir(legacyDefault))) legacyRoots.add(path.resolve(legacyDefault));
  for (const root of legacyRoots) {
    if (samePath(root, dotMc)) {
      // Legacy Launcher pointed at .minecraft: without the official launcher, that folder runs through it
      const e = out.find((x) => samePath(x.path, dotMc));
      if (e && !(officialExe ?? exe.official)) {
        e.via = 'legacy';
        e.install = { launcher: 'legacy', launcherRoot: dotMc, launcherExe: exe.legacy };
      }
      out.push(...(await withHomeFolders(root, 'legacy', exe.legacy, 'Legacy Launcher')).slice(1));
    } else out.push(...(await withHomeFolders(root, 'legacy', exe.legacy, 'Legacy Launcher')));
  }

  // Prism and MultiMC (installed or portable)
  const prismRoots = [path.join(env.appData, 'PrismLauncher'), path.join(env.home, 'scoop', 'persist', 'prismlauncher')];
  if (exe.prism) prismRoots.push(path.dirname(exe.prism));
  const prismExe = exe.prism ?? (await firstExisting([path.join(env.localAppData, 'Programs', 'PrismLauncher', 'prismlauncher.exe'), ...env.programFiles.map((p) => path.join(p, 'PrismLauncher', 'prismlauncher.exe'))]));
  const seenRoots: string[] = [];
  for (const root of prismRoots) {
    if (seenRoots.some((r) => samePath(r, root)) || !(await isDir(root))) continue;
    seenRoots.push(root);
    const portableExe = await firstExisting([path.join(root, 'prismlauncher.exe')]);
    out.push(...(await mmcInstances(root, 'prism', portableExe ?? prismExe)));
  }
  const mmcRoots = [path.join(env.localAppData, 'MultiMC'), path.join(env.home, 'MultiMC'), path.join(env.home, 'Desktop', 'MultiMC'), path.join(env.home, 'Downloads', 'MultiMC'), 'C:\\MultiMC'];
  if (exe.multimc) mmcRoots.unshift(path.dirname(exe.multimc));
  for (const root of mmcRoots) {
    if (seenRoots.some((r) => samePath(r, root)) || !(await exists(path.join(root, 'multimc.cfg')))) continue;
    seenRoots.push(root);
    out.push(...(await mmcInstances(root, 'multimc', (await firstExisting([path.join(root, 'MultiMC.exe')])) ?? exe.multimc)));
  }

  // CurseForge
  for (const dir of await dirs(path.join(env.home, 'curseforge', 'minecraft', 'Instances'))) {
    const j = await readJson<{ name?: string; gameVersion?: string; baseModLoader?: { name?: string } }>(path.join(dir, 'minecraftinstance.json'));
    if (!j && !(await looksLikeGameDir(dir))) continue;
    const loader = /^(fabric|quilt|neoforge|forge)/i.exec(j?.baseModLoader?.name ?? '')?.[1]?.toLowerCase();
    out.push({ path: dir, via: 'curseforge', label: j?.name || path.basename(dir), gameVersion: j?.gameVersion, loader, install: { launcher: 'curseforge', launcherExe: exe.curseforge } });
  }

  // Modrinth App (current and old folder)
  for (const base of [path.join(env.appData, 'ModrinthApp', 'profiles'), path.join(env.appData, 'com.modrinth.theseus', 'profiles')]) {
    for (const dir of await dirs(base)) {
      const j = await readJson<{ metadata?: { name?: string; game_version?: string; loader?: string } }>(path.join(dir, 'profile.json'));
      const loader = j?.metadata?.loader && j.metadata.loader !== 'vanilla' ? j.metadata.loader : undefined;
      out.push({ path: dir, via: 'modrinth', label: j?.metadata?.name || path.basename(dir), gameVersion: j?.metadata?.game_version, loader, install: { launcher: 'modrinth', launcherExe: exe.modrinth } });
    }
  }

  // ATLauncher
  const atRoots = [path.join(env.appData, 'ATLauncher')];
  if (exe.atlauncher) atRoots.unshift(path.dirname(exe.atlauncher));
  for (const root of [...new Set(atRoots)]) {
    for (const dir of await dirs(path.join(root, 'instances'))) {
      const j = await readJson<{ id?: string; launcher?: { name?: string; loaderVersion?: { type?: string } } }>(path.join(dir, 'instance.json'));
      if (!j) continue;
      out.push({ path: dir, via: 'atlauncher', label: j.launcher?.name || path.basename(dir), gameVersion: j.id, loader: j.launcher?.loaderVersion?.type?.toLowerCase(), install: { launcher: 'atlauncher', launcherExe: exe.atlauncher } });
    }
  }

  // one entry per folder
  const unique: McCopy[] = [];
  for (const c of out) if (!unique.some((u) => samePath(u.path, c.path))) unique.push(c);
  return unique;
}

// ---------- other games

interface StoreCandidate {
  dir: string;
  store: GameStore;
  epicId?: string;
}

interface EpicManifest {
  InstallLocation?: string;
  AppName?: string;
  CatalogNamespace?: string;
  CatalogItemId?: string;
}

async function epicManifests(env: DetectEnv): Promise<EpicManifest[]> {
  const dir = path.join(env.programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  const out: EpicManifest[] = [];
  for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!/\.item$/i.test(f)) continue;
    const j = await readJson<EpicManifest>(path.join(dir, f));
    if (j?.InstallLocation) out.push(j);
  }
  return out;
}

const epicIdOf = (m: EpicManifest) => (m.AppName ? [m.CatalogNamespace, m.CatalogItemId, m.AppName].filter(Boolean).join(':') : undefined);

async function storeCandidates(env: DetectEnv): Promise<StoreCandidate[]> {
  const out: StoreCandidate[] = [];
  for (const lib of await env.steamLibraries().catch(() => [] as string[])) {
    for (const d of await dirs(path.join(lib, 'steamapps', 'common'))) out.push({ dir: d, store: 'steam' });
  }
  for (const p of await env.gogPaths().catch(() => [] as string[])) out.push({ dir: p, store: 'gog' });
  for (const base of ['C:\\GOG Games', ...env.programFiles.map((p) => path.join(p, 'GOG Galaxy', 'Games'))]) {
    for (const d of await dirs(base)) out.push({ dir: d, store: 'gog' });
  }
  for (const m of await epicManifests(env)) out.push({ dir: m.InstallLocation!, store: 'epic', epicId: epicIdOf(m) });
  for (const base of env.programFiles.map((p) => path.join(p, 'Epic Games'))) for (const d of await dirs(base)) out.push({ dir: d, store: 'epic' });
  for (const drive of env.drives) {
    for (const d of await dirs(path.join(drive, 'XboxGames'))) out.push({ dir: path.join(d, 'Content'), store: 'xbox' });
  }
  return out;
}

async function hasMarker(def: GameDef, dir: string) {
  for (const rel of def.exe ?? []) if (await exists(path.join(dir, rel))) return true;
  return false;
}

/** Store of a game folder, from the traces each store leaves. */
export async function storeOf(dir: string, env: DetectEnv): Promise<{ store: GameStore; epicId?: string }> {
  if (/[\\/]steamapps[\\/]common[\\/]/i.test(dir)) return { store: 'steam' };
  if (await exists(path.join(dir, '.egstore'))) {
    const m = (await epicManifests(env)).find((x) => samePath(x.InstallLocation!, dir));
    return { store: 'epic', epicId: m ? epicIdOf(m) : undefined };
  }
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  if (files.some((f) => /^goggame-\d+\.(info|ico)$/i.test(f))) return { store: 'gog' };
  if (/[\\/]XboxGames[\\/]/i.test(dir) || /[\\/]WindowsApps[\\/]/i.test(dir)) return { store: 'xbox' };
  return { store: 'other' };
}

/** Every copy of every supported game found on this computer. */
export async function detectAll(env: DetectEnv, officialExe?: string): Promise<DetectedGame[]> {
  const found: DetectedGame[] = [];
  for (const c of await detectMinecraft(env, officialExe)) found.push({ ...c, defId: 'minecraft' });
  const cands = await storeCandidates(env);
  for (const def of GAME_DEFS) {
    if (def.kind === 'minecraft' || !def.exe?.length) continue;
    for (const c of cands) {
      if (found.some((f) => f.defId === def.id && samePath(f.path, c.dir))) continue;
      if (await hasMarker(def, c.dir)) found.push({ defId: def.id, path: path.resolve(c.dir), via: c.store, install: { store: c.store, epicId: c.epicId } });
    }
  }
  return found;
}

/**
 * What a folder the user picked is: which launcher or store it belongs to.
 * For a Prism/MultiMC instance folder the game folder inside it is returned.
 */
export async function inspectFolder(defId: string, dir: string, env: DetectEnv, officialExe?: string): Promise<{ path: string; install: InstallInfo; gameVersion?: string; loader?: string }> {
  const def = GAME_DEFS.find((d) => d.id === defId);
  let p = path.resolve(dir);
  if (def?.kind === 'minecraft') {
    if (await exists(path.join(p, 'instance.cfg'))) p = await mmcGameRoot(p);
    const known = (await detectMinecraft(env, officialExe)).find((c) => samePath(c.path, p));
    if (known) return { path: known.path, install: known.install, gameVersion: known.gameVersion, loader: known.loader };
    // an instance of a portable Prism/MultiMC we did not know about
    const parent = path.dirname(p);
    if (/^\.?minecraft$/i.test(path.basename(p)) && (await exists(path.join(parent, 'instance.cfg')))) {
      const root = path.dirname(path.dirname(parent));
      const launcher = (await exists(path.join(root, 'multimc.cfg'))) ? 'multimc' : 'prism';
      const list = await mmcInstances(root, launcher, await firstExisting([path.join(root, launcher === 'prism' ? 'prismlauncher.exe' : 'MultiMC.exe')]));
      const hit = list.find((c) => samePath(c.path, p));
      if (hit) return { path: hit.path, install: hit.install, gameVersion: hit.gameVersion, loader: hit.loader };
    }
    if (await exists(path.join(p, 'launcher_profiles.json'))) return { path: p, install: { launcher: 'official', launcherRoot: p, launcherExe: officialExe } };
    return { path: p, install: { launcher: 'other' } };
  }
  return { path: p, install: await storeOf(p, env) };
}
