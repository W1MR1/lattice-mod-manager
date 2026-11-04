// Starting a game with its mods: Minecraft needs a mod loader profile in the
// official launcher (Fabric and Quilt publish ready launcher profiles), Steam
// games start through Steam, Bethesda games through their script extender.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GameDef } from '../../shared/types';
import { getJson } from './http';

export type LaunchTarget = { kind: 'steam'; appId: string } | { kind: 'exe'; path: string };

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
export async function installMinecraftLoader(gameDir: string, gameVersion: string, loader: string, profileId: string, profileName: string): Promise<LoaderResult> {
  const meta = LOADER_META[loader];
  if (!meta) {
    throw new Error(
      `${loader === 'neoforge' ? 'NeoForge' : 'Forge'} ставится только своим официальным установщиком (neoforged.net / files.minecraftforge.net). Установите его, затем выберите его профиль в лаунчере Minecraft.`,
    );
  }
  const list = await getJson<{ loader: { version: string; stable?: boolean } }[]>(meta.list(gameVersion), {}, 3_600_000);
  const pick = list.find((x) => x.loader.stable) ?? list.find((x) => !/beta|alpha|rc/i.test(x.loader.version)) ?? list[0];
  if (!pick) throw new Error(`Загрузчик ${loader} не поддерживает Minecraft ${gameVersion}`);
  const profile = await getJson<{ id: string }>(meta.profile(gameVersion, pick.loader.version), {}, 3_600_000);

  const dir = path.join(gameDir, 'versions', profile.id);
  const json = path.join(dir, `${profile.id}.json`);
  const installed = !(await exists(json));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(json, JSON.stringify(profile, null, 2));
  // the launcher expects a jar beside the json; the loader's installers write an empty one
  const jar = path.join(dir, `${profile.id}.jar`);
  if (!(await exists(jar))) await fs.writeFile(jar, Buffer.alloc(0));

  const profilesPath = path.join(gameDir, 'launcher_profiles.json');
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

const SCRIPT_EXTENDERS: Record<string, string[]> = {
  skyrimse: ['skse64_loader.exe'],
  fallout4: ['f4se_loader.exe'],
};

/** How to start a non-Minecraft game with its deployed mods. */
export async function gameLaunchTarget(def: GameDef, installPath: string): Promise<LaunchTarget> {
  for (const exe of SCRIPT_EXTENDERS[def.id] ?? []) {
    const p = path.join(installPath, exe);
    if (await exists(p)) return { kind: 'exe', path: p };
  }
  if (def.steamAppId) return { kind: 'steam', appId: def.steamAppId };
  throw new Error('Не знаю, как запустить эту игру: запустите её как обычно — моды уже в её папке');
}
