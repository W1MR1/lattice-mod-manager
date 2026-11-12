// Whether a mod version can run in a profile's context (game version + mod loader).
import type { GameContext } from './types';

const MOD_LOADERS = new Set(['fabric', 'forge', 'neoforge', 'quilt', 'liteloader', 'rift', 'modloader']);

/** Loaders that can also run mods built for another loader. */
const LOADER_ACCEPTS: Record<string, string[]> = {
  quilt: ['quilt', 'fabric'],
};

const LOADER_NAME: Record<string, string> = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };

/** A loader as people write it: "Fabric", "NeoForge". */
export function loaderLabel(loader?: string): string {
  return LOADER_NAME[loader ?? ''] ?? loader ?? '';
}

export function loaderFits(loaders: string[], loader?: string): boolean {
  if (!loader || loaders.length === 0) return true;
  const modLoaders = loaders.filter((l) => MOD_LOADERS.has(l));
  // resource packs, shaders and data packs are loader-agnostic
  if (modLoaders.length === 0) return true;
  const accepted = LOADER_ACCEPTS[loader] ?? [loader];
  return modLoaders.some((l) => accepted.includes(l));
}

export function gameVersionFits(gameVersions: string[], gameVersion?: string): boolean {
  if (!gameVersion || gameVersions.length === 0) return true;
  return gameVersions.includes(gameVersion);
}

export function fitsContext(v: { gameVersions: string[]; loaders: string[] }, ctx: GameContext): boolean {
  return gameVersionFits(v.gameVersions, ctx.gameVersion) && loaderFits(v.loaders, ctx.loader);
}
