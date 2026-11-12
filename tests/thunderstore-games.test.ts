// The games taken from Thunderstore's own list: well-formed, found only where
// Steam keeps that very game, and their mod loader is told from a mod.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectAll, type DetectEnv } from '../electron/core/detect';
import { GAME_DEFS, gameDef, isBepInExPack, isThunderstoreMod } from '../electron/core/games';
import { bepinexMapper } from '../electron/core/installer';
import { communityDeps } from '../electron/core/sources/thunderstore';

const tmp = (p: string) => fs.mkdtemp(path.join(os.tmpdir(), `lattice-${p}-`));

describe('games from the Thunderstore list', () => {
  const listed = GAME_DEFS.filter((d) => d.catalog);

  it('there are hundreds of them and each has what Lattice needs', () => {
    expect(listed.length).toBeGreaterThan(200);
    for (const d of listed) {
      expect(d.kind, d.id).toBe('bepinex');
      expect(d.thunderstoreCommunity, d.id).toMatch(/^[a-z0-9-]+$/);
      expect(d.steamAppId, d.id).toMatch(/^\d+$/);
      expect(d.steamFolder, d.id).toBeTruthy();
      expect(d.exe?.length, d.id).toBeGreaterThan(0);
      for (const e of d.exe!) expect(e, d.id).toMatch(/\.exe$/i);
      expect(d.short.length, d.id).toBeGreaterThan(0);
      expect(d.short.length, d.id).toBeLessThanOrEqual(2);
      expect(d.sources).toEqual(['thunderstore', 'local']);
    }
  });

  it('ids are unique and a game written by hand is not listed twice', () => {
    const ids = GAME_DEFS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    const byCommunity = GAME_DEFS.filter((d) => d.thunderstoreCommunity === 'lethal-company');
    expect(byCommunity).toHaveLength(1);
    expect(byCommunity[0].catalog).toBeUndefined();
    // known games of the list
    expect(gameDef('repo')?.name).toBe('R.E.P.O.');
    expect(gameDef('peak')?.steamAppId).toBe('3527290');
  });

  it('a game is found in its own Steam folder, and not by its executable name elsewhere', async () => {
    const home = await tmp('ts-detect');
    const lib = path.join(home, 'SteamLibrary');
    const repo = path.join(lib, 'steamapps', 'common', 'REPO');
    const other = path.join(lib, 'steamapps', 'common', 'Some Other Game');
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(repo, 'REPO.exe'), '');
    // another game that happens to ship an executable with PEAK's name
    await fs.writeFile(path.join(other, 'PEAK.exe'), '');
    const env: DetectEnv = { home, appData: path.join(home, 'Roaming'), localAppData: path.join(home, 'Local'), programData: path.join(home, 'PD'), programFiles: [], drives: [], steamLibraries: async () => [lib], gogPaths: async () => [] };
    const found = await detectAll(env);
    expect(found.filter((f) => f.defId === 'repo').map((f) => f.path)).toEqual([path.resolve(repo)]);
    expect(found.find((f) => f.defId === 'repo')?.install.store).toBe('steam');
    expect(found.some((f) => f.defId === 'peak')).toBe(false);
  });

  it('the mod loader package is known by name, whatever it is called', () => {
    expect(isBepInExPack('BepInEx-BepInExPack')).toBe(true);
    expect(isBepInExPack('BepInEx-BepInExPack_PEAK')).toBe(true);
    // packs whose names do not say "BepInExPack"
    expect(isBepInExPack('xiaoye97-BepInEx')).toBe(true);
    expect(isBepInExPack('bbepis-BepInEx_Rogue_Tower')).toBe(true);
    expect(isBepInExPack('Zehs-REPOLib')).toBe(false);
  });

  it('other mod managers listed in every community are not offered as mods', () => {
    expect(isThunderstoreMod('ebkr-r2modman')).toBe(false);
    expect(isThunderstoreMod('Kesomannen-GaleModManager')).toBe(false);
    expect(isThunderstoreMod('Zehs-REPOLib')).toBe(true);
    expect(isThunderstoreMod('BepInEx-BepInExPack')).toBe(true);
  });

  it('a package asks for the loader of the community it is installed in', () => {
    const inPeak = (id: string) => ['BepInEx-BepInExPack_PEAK', 'Some-Library'].includes(id);
    // written for another community: its loader is not listed here, PEAK's own is
    expect(communityDeps('loaforc-loaforcsSoundAPI', ['BepInEx-BepInExPack-5.4.2100'], inPeak, 'BepInEx-BepInExPack_PEAK')).toEqual([{ projectId: 'BepInEx-BepInExPack_PEAK' }]);
    // a loader that is listed here is kept with its version
    expect(communityDeps('A-Mod', ['BepInEx-BepInExPack_PEAK-5.4.2403', 'Some-Library-1.0.0'], inPeak, 'BepInEx-BepInExPack_PEAK')).toEqual([
      { projectId: 'BepInEx-BepInExPack_PEAK', version: '5.4.2403' },
      { projectId: 'Some-Library', version: '1.0.0' },
    ]);
    // a plugin that names no loader still needs one
    expect(communityDeps('sinai-dev-UnityExplorer', [], inPeak, 'BepInEx-BepInExPack_PEAK')).toEqual([{ projectId: 'BepInEx-BepInExPack_PEAK' }]);
    // the loader itself asks for nothing, and a community without a known loader is left as it is
    expect(communityDeps('BepInEx-BepInExPack_PEAK', [], inPeak, 'BepInEx-BepInExPack_PEAK')).toEqual([]);
    expect(communityDeps('A-Mod', ['Some-Library-1.0.0'], inPeak, undefined)).toEqual([{ projectId: 'Some-Library', version: '1.0.0' }]);
  });

  it('a loader pack lands in the game root, a mod under BepInEx/plugins/<package>', () => {
    const pack = bepinexMapper('xiaoye97-BepInEx', ['BepInExPack/winhttp.dll', 'BepInExPack/doorstop_config.ini', 'BepInExPack/BepInEx/core/BepInEx.dll', 'manifest.json'], true);
    expect(pack('BepInExPack/winhttp.dll')).toBe('winhttp.dll');
    expect(pack('BepInExPack/BepInEx/core/BepInEx.dll')).toBe('BepInEx/core/BepInEx.dll');
    expect(pack('manifest.json')).toBeNull();
    const mod = bepinexMapper('Zehs-REPOLib', ['REPOLib.dll', 'plugins/extra.dll', 'config/repolib.cfg'], false);
    expect(mod('REPOLib.dll')).toBe('BepInEx/plugins/Zehs-REPOLib/REPOLib.dll');
    expect(mod('plugins/extra.dll')).toBe('BepInEx/plugins/Zehs-REPOLib/extra.dll');
    expect(mod('config/repolib.cfg')).toBe('BepInEx/config/repolib.cfg');
  });
});
