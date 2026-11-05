// Starting a game with its mods: Minecraft needs a mod loader profile in the
// official launcher (Fabric and Quilt publish ready launcher profiles), Steam
// games start through Steam, Bethesda games through their script extender.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GameDef, InstallInfo } from '../../shared/types';
import { getJson, HttpError } from './http';
import { t } from '../../shared/i18n';

export type LaunchTarget = { kind: 'steam'; appId: string } | { kind: 'exe'; path: string; args?: string[] } | { kind: 'url'; url: string };

export interface LoaderResult {
  versionId: string;
  profileName: string;
  /** false when the version was already there */
  installed: boolean;
}

const LOADER_META: Record<string, { list: (mc: string) => string; profile: (mc: string, l: string) => string }> = {
  fabric: {
    list: (mc) => `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}`,
    profile: (mc, l) => `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(l)}/profile/json`,
  },
  quilt: {
    list: (mc) => `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mc)}`,
    profile: (mc, l) => `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(l)}/profile/json`,
  },
};

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** True when the folder belongs to the official Minecraft launcher (not Prism, MultiMC, TLauncher…). */
export function isOfficialMinecraftDir(dir: string): Promise<boolean> {
  return exists(path.join(dir, 'launcher_profiles.json'));
}

/**
 * Puts a Fabric or Quilt loader version into the official launcher's folder and
 * adds (or refreshes) a launcher profile for it, as the loaders' own installers do.
 */
/**
 * `root` is the launcher folder with versions/ (and launcher_profiles.json for
 * the official launcher). When the mods live elsewhere (`gameDir`, e.g. a
 * separate game folder of an installation), the launcher profile points there.
 */
export async function installMinecraftLoader(root: string, gameVersion: string, loader: string, profileId: string, profileName: string, gameDir?: string): Promise<LoaderResult> {
  const gameDirOfRoot = root;
  const meta = LOADER_META[loader];
  if (!meta) {
    throw new Error(
      t('{0} ставится только своим официальным установщиком (neoforged.net / files.minecraftforge.net). Установите его, затем выберите его профиль в лаунчере Minecraft.', loader === 'neoforge' ? 'NeoForge' : 'Forge'),
    );
  }
  const loaderName = loader === 'quilt' ? 'Quilt' : 'Fabric';
  // Fabric answers 400 "[]" (Quilt 404) for a Minecraft version it does not know, e.g. a snapshot
  const list = await getJson<{ loader: { version: string; stable?: boolean } }[]>(meta.list(gameVersion), {}, 3_600_000).catch((e) => {
    if (e instanceof HttpError && (e.status === 400 || e.status === 404)) return [];
    throw e;
  });
  const pick = list.find((x) => x.loader.stable) ?? list.find((x) => !/beta|alpha|rc/i.test(x.loader.version)) ?? list[0];
  if (!pick) throw new Error(t('{0} не поддерживает Minecraft {1}: выберите в профиле версию, для которой есть {0}.', loaderName, gameVersion));
  const profile = await getJson<{ id: string }>(meta.profile(gameVersion, pick.loader.version), {}, 3_600_000);

  const dir = path.join(root, 'versions', profile.id);
  const json = path.join(dir, `${profile.id}.json`);
  const installed = !(await exists(json));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(json, JSON.stringify(profile, null, 2));
  // the launcher expects a jar beside the json; the loader's installers write an empty one
  const jar = path.join(dir, `${profile.id}.jar`);
  if (!(await exists(jar))) await fs.writeFile(jar, Buffer.alloc(0));

  const profilesPath = path.join(gameDirOfRoot, 'launcher_profiles.json');
  // Legacy Launcher and TLauncher list versions/ by themselves; only the official launcher needs a profile
  if (!(await exists(profilesPath))) return { versionId: profile.id, profileName: '', installed };
  const raw = await fs.readFile(profilesPath, 'utf8');
  const backup = `${profilesPath}.lattice-bak`;
  if (!(await exists(backup))) await fs.writeFile(backup, raw);
  const doc = JSON.parse(raw) as { profiles?: Record<string, Record<string, unknown>> };
  doc.profiles ??= {};
  const now = new Date().toISOString();
  const name = `Lattice · ${profileName}`;
  const key = `lattice-${profileId}`;
  doc.profiles[key] = {
    ...doc.profiles[key],
    name,
    type: 'custom',
    icon: 'Furnace',
    lastVersionId: profile.id,
    ...(gameDir && path.resolve(gameDir).toLowerCase() !== path.resolve(root).toLowerCase() ? { gameDir: path.resolve(gameDir) } : {}),
    created: (doc.profiles[key]?.created as string) ?? now,
    // the launcher lists the most recently used profile first
    lastUsed: now,
  };
  await fs.writeFile(profilesPath, JSON.stringify(doc, null, 2));
  return { versionId: profile.id, profileName: name, installed };
}

/** Where the official Minecraft launcher usually lives on Windows. */
export async function findMinecraftLauncher(): Promise<string | null> {
  const env = process.env;
  const candidates = [
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Minecraft Launcher', 'MinecraftLauncher.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Minecraft Launcher', 'MinecraftLauncher.exe'),
    'C:\\XboxGames\\Minecraft Launcher\\Content\\Minecraft.exe',
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Minecraft Launcher', 'MinecraftLauncher.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Minecraft Launcher', 'MinecraftLauncher.exe'),
  ].filter(Boolean) as string[];
  for (const c of candidates) if (await exists(c)) return c;
  return null;
}

/** Loaders that must start the game for its mods to load. */
const SCRIPT_EXTENDERS: Record<string, string[]> = {
  skyrimse: ['skse64_loader.exe'],
  fallout4: ['f4se_loader.exe'],
  stardewvalley: ['StardewModdingAPI.exe'],
};

/** How to start a non-Minecraft game with its deployed mods. */
/** How to start a game copy: its mod loader, its store, or its executable. */
export async function gameLaunchTarget(def: GameDef, installPath: string, install?: InstallInfo): Promise<LaunchTarget> {
  if (install?.customExe && install.launcherExe) return { kind: 'exe', path: install.launcherExe };
  for (const exe of SCRIPT_EXTENDERS[def.id] ?? []) {
    const p = path.join(installPath, exe);
    if (await exists(p)) return { kind: 'exe', path: p };
  }
  const store = install?.store;
  if (store === 'xbox') throw new Error(t('Игры из Xbox и Game Pass Lattice запустить не может: запустите её через приложение Xbox — моды уже в её папке'));
  if (store === 'epic' && install?.epicId) {
    return { kind: 'url', url: `com.epicgames.launcher://apps/${install.epicId.split(':').map(encodeURIComponent).join('%3A')}?action=launch&silent=true` };
  }
  if (def.steamAppId && (store === 'steam' || (!store && /[\\/]steamapps[\\/]/i.test(installPath)))) return { kind: 'steam', appId: def.steamAppId };
  for (const rel of def.exe ?? []) {
    const p = path.join(installPath, rel);
    if (await exists(p)) return { kind: 'exe', path: p };
  }
  if (def.steamAppId) return { kind: 'steam', appId: def.steamAppId };
  throw new Error(t('Не знаю, как запустить эту игру: запустите её как обычно — моды уже в её папке'));
}
