// Where the files of an archive go, for the ways authors really pack mods.
import { describe, expect, it } from 'vitest';
import { gameDef } from '../electron/core/games';
import { checkStaged, GAME_ROOT, modFolderName, planLayout, TOP_FILES } from '../electron/core/layout';

const cp = gameDef('cyberpunk2077')!;
const sk = gameDef('skyrimse')!;
const sv = gameDef('stardewvalley')!;
const vh = gameDef('valheim')!;
const CET = 'bin/x64/plugins/cyber_engine_tweaks/mods';

/** archive entry -> where it lands, as a plain object */
const placed = (def: typeof cp, names: string[], mod = 'My Mod', choice?: Parameters<typeof planLayout>[3]) => {
  const p = planLayout(def, names, mod, choice);
  return { plan: p, files: Object.fromEntries(p.map) };
};

describe('Cyberpunk 2077 archives', () => {
  it('leaves an archive packed for the game folder as it is, without its papers', () => {
    const { plan, files } = placed(cp, ['archive/pc/mod/a.archive', 'r6/scripts/x/y.reds', 'readme.txt', 'preview.png']);
    expect(files).toEqual({ 'archive/pc/mod/a.archive': 'archive/pc/mod/a.archive', 'r6/scripts/x/y.reds': 'r6/scripts/x/y.reds' });
    expect(plan.how).toBe('as-is');
    expect(plan.ask).toBeUndefined();
  });

  it('takes wrapper folders off, however many there are', () => {
    expect(placed(cp, ['MyMod/archive/pc/mod/a.archive']).files).toEqual({ 'MyMod/archive/pc/mod/a.archive': 'archive/pc/mod/a.archive' });
    const deep = placed(cp, [`Download/MyMod v1/${CET}/m/init.lua`, 'Download/readme.md']);
    expect(deep.files).toEqual({ [`Download/MyMod v1/${CET}/m/init.lua`]: `${CET}/m/init.lua` });
    expect(deep.plan.how).toBe('arranged');
  });

  it('puts loose files where the game reads them', () => {
    expect(placed(cp, ['a.archive', 'a.archive.xl']).files).toEqual({ 'a.archive': 'archive/pc/mod/a.archive', 'a.archive.xl': 'archive/pc/mod/a.archive.xl' });
    expect(placed(cp, ['sub/dir/deep.archive']).files).toEqual({ 'sub/dir/deep.archive': 'archive/pc/mod/deep.archive' });
    expect(placed(cp, ['myscript.reds'], 'Cool Mod').files).toEqual({ 'myscript.reds': 'r6/scripts/Cool Mod/myscript.reds' });
    expect(placed(cp, ['tweak.yaml'], 'Cool Mod').files).toEqual({ 'tweak.yaml': 'r6/tweaks/Cool Mod/tweak.yaml' });
  });

  it('knows a Cyber Engine Tweaks mod by its init.lua, even with a folder called bin inside', () => {
    const { files } = placed(cp, ['MyCet/init.lua', 'MyCet/modules/x.lua', 'MyCet/bin/helper.lua', 'MyCet/readme.txt']);
    expect(files).toEqual({
      'MyCet/init.lua': `${CET}/MyCet/init.lua`,
      'MyCet/modules/x.lua': `${CET}/MyCet/modules/x.lua`,
      'MyCet/bin/helper.lua': `${CET}/MyCet/bin/helper.lua`,
    });
    expect(placed(cp, ['init.lua', 'data.json'], 'Top Cet').files).toEqual({ 'init.lua': `${CET}/Top Cet/init.lua`, 'data.json': `${CET}/Top Cet/data.json` });
  });

  it('knows a REDmod folder and keeps its archives inside it', () => {
    const { files } = placed(cp, ['MyRed/info.json', 'MyRed/archives/x.archive']);
    expect(files).toEqual({ 'MyRed/info.json': 'mods/MyRed/info.json', 'MyRed/archives/x.archive': 'mods/MyRed/archives/x.archive' });
  });

  it('sorts a mix of a game-folder tree and loose files', () => {
    const { files } = placed(cp, ['archive/pc/mod/a.archive', 'extra.archive', 'Tool/init.lua']);
    expect(files).toEqual({ 'archive/pc/mod/a.archive': 'archive/pc/mod/a.archive', 'extra.archive': 'archive/pc/mod/extra.archive', 'Tool/init.lua': `${CET}/Tool/init.lua` });
  });

  it('asks when the archive holds several variants, and installs the one picked', () => {
    const names = ['Option A/archive/pc/mod/a.archive', 'Option B/archive/pc/mod/b.archive'];
    const { plan } = placed(cp, names);
    expect(plan.ask?.reason).toBe('variants');
    expect(plan.ask?.options.map((o) => o.path)).toEqual(['Option A/', 'Option B/']);
    expect(plan.ask?.options.filter((o) => o.suggested)).toHaveLength(1);
    const b = placed(cp, names, 'My Mod', { roots: ['Option B/'] });
    expect(b.plan.ask).toBeUndefined();
    expect(b.files).toEqual({ 'Option B/archive/pc/mod/b.archive': 'archive/pc/mod/b.archive' });
    expect(b.plan.extras.map((o) => o.path)).toEqual(['Option A/']);
    // both at once: the later one wins a shared file
    expect(Object.keys(placed(cp, names, 'My Mod', { roots: ['Option A/', 'Option B/'] }).files)).toHaveLength(2);
  });

  it('asks when nothing is recognisable, and obeys a destination chosen by hand', () => {
    const names = ['stuff/a.bin', 'b.dat'];
    const { plan } = placed(cp, names);
    expect(plan.ask?.reason).toBe('unknown');
    expect(plan.ask?.options.map((o) => o.path).sort()).toEqual([TOP_FILES, 'stuff/'].sort());
    expect(plan.ask?.dests.some((d) => d.id === 'red4ext/plugins/{mod}')).toBe(true);
    const manual = placed(cp, names, 'Cool Mod', { roots: ['stuff/'], dest: 'red4ext/plugins/{mod}' });
    expect(manual.files).toEqual({ 'stuff/a.bin': 'red4ext/plugins/Cool Mod/a.bin' });
    expect(placed(cp, names, 'Cool Mod', { roots: [TOP_FILES], dest: '' }).files).toEqual({ 'b.dat': 'b.dat' });
  });

  it('names mod folders after the archive, without what Nexus adds', () => {
    expect(modFolderName('Cool Mod-1234-1-2-1700000000.zip')).toBe('Cool Mod');
    expect(modFolderName('a<b>:c.7z')).toBe('a b c');
    expect(modFolderName('')).toBe('mod');
  });
});

describe('Skyrim and Fallout 4 archives', () => {
  it('reads Data-relative mods, with or without a Data folder or wrappers', () => {
    expect(placed(sk, ['meshes/a.nif', 'MyMod.esp', 'readme.txt']).files).toEqual({ 'meshes/a.nif': 'meshes/a.nif', 'MyMod.esp': 'MyMod.esp' });
    expect(placed(sk, ['Data/meshes/a.nif', 'Data/MyMod.esp']).files).toEqual({ 'Data/meshes/a.nif': 'meshes/a.nif', 'Data/MyMod.esp': 'MyMod.esp' });
    expect(placed(sk, ['MyMod 1.0/Data/meshes/a.nif']).files).toEqual({ 'MyMod 1.0/Data/meshes/a.nif': 'meshes/a.nif' });
    expect(placed(sk, ['MyMod 1.0/textures/a.dds', 'MyMod 1.0/MyMod.esp']).files).toEqual({ 'MyMod 1.0/textures/a.dds': 'textures/a.dds', 'MyMod 1.0/MyMod.esp': 'MyMod.esp' });
  });

  it('sends a script extender to the game folder and its scripts to Data', () => {
    const root = 'skse64_2_02_06';
    const { files } = placed(sk, [`${root}/skse64_loader.exe`, `${root}/skse64_1_6_1170.dll`, `${root}/Data/Scripts/a.pex`, `${root}/src/x.cpp`, `${root}/skse64_readme.txt`]);
    expect(files).toEqual({
      [`${root}/skse64_loader.exe`]: `${GAME_ROOT}/skse64_loader.exe`,
      [`${root}/skse64_1_6_1170.dll`]: `${GAME_ROOT}/skse64_1_6_1170.dll`,
      [`${root}/Data/Scripts/a.pex`]: 'Scripts/a.pex',
    });
  });

  it('understands the Root folder habit of Mod Organizer', () => {
    expect(placed(sk, ['Root/d3d11.dll', 'meshes/x.nif']).files).toEqual({ 'Root/d3d11.dll': `${GAME_ROOT}/d3d11.dll`, 'meshes/x.nif': 'meshes/x.nif' });
  });

  it('asks about numbered variants and suggests the core', () => {
    const { plan } = placed(sk, ['00 Core/meshes/a.nif', '01 Blue/textures/b.dds', '02 Red/textures/b.dds']);
    expect(plan.ask?.reason).toBe('variants');
    expect(plan.ask?.options.filter((o) => o.suggested).map((o) => o.path)).toEqual(['00 Core/']);
    // installing without an answer takes the suggested part only
    expect(Object.fromEntries(plan.map)).toEqual({ '00 Core/meshes/a.nif': 'meshes/a.nif' });
  });

  it('installs the main part and keeps optional folders as extras', () => {
    const { plan, files } = placed(sk, ['textures/a.dds', 'Optional/Darker/textures/a.dds', 'Optional/notes.txt']);
    expect(files).toEqual({ 'textures/a.dds': 'textures/a.dds' });
    expect(plan.ask).toBeUndefined();
    expect(plan.extras.map((o) => o.path)).toEqual(['Optional/Darker/']);
    const both = placed(sk, ['textures/a.dds', 'Optional/Darker/textures/a.dds'], 'm', { roots: ['', 'Optional/Darker/'] });
    expect(both.files['Optional/Darker/textures/a.dds']).toBe('textures/a.dds');
  });
});

describe('Stardew Valley archives', () => {
  it('gives every SMAPI mod its own folder in Mods', () => {
    expect(placed(sv, ['MyMod/manifest.json', 'MyMod/MyMod.dll']).files).toEqual({ 'MyMod/manifest.json': 'MyMod/manifest.json', 'MyMod/MyMod.dll': 'MyMod/MyMod.dll' });
    expect(placed(sv, ['manifest.json', 'Mod.dll'], 'Loose Mod').files).toEqual({ 'manifest.json': 'Loose Mod/manifest.json', 'Mod.dll': 'Loose Mod/Mod.dll' });
    const wrapped = placed(sv, ['Download/[CP] Thing/manifest.json', 'Download/[CP] Thing/content.json', 'Download/[JA] Thing/manifest.json', 'Download/readme.txt']);
    expect(wrapped.files).toEqual({
      'Download/[CP] Thing/manifest.json': '[CP] Thing/manifest.json',
      'Download/[CP] Thing/content.json': '[CP] Thing/content.json',
      'Download/[JA] Thing/manifest.json': '[JA] Thing/manifest.json',
    });
    expect(placed(sv, ['Mods/MyMod/manifest.json']).files).toEqual({ 'Mods/MyMod/manifest.json': 'MyMod/manifest.json' });
  });

  it('asks about an archive without a manifest', () => {
    expect(placed(sv, ['something/file.xnb']).plan.ask?.reason).toBe('unknown');
    expect(placed(sv, ['Content/Portraits/Abigail.xnb']).files).toEqual({ 'Content/Portraits/Abigail.xnb': `${GAME_ROOT}/Content/Portraits/Abigail.xnb` });
  });
});

describe('BepInEx archives from outside Thunderstore', () => {
  it('finds the BepInEx tree under wrappers and keeps it', () => {
    expect(placed(vh, ['BepInEx/plugins/X.dll']).files).toEqual({ 'BepInEx/plugins/X.dll': 'BepInEx/plugins/X.dll' });
    expect(placed(vh, ['MyMod/BepInEx/plugins/X.dll', 'MyMod/README.md']).files).toEqual({ 'MyMod/BepInEx/plugins/X.dll': 'BepInEx/plugins/X.dll' });
  });

  it('puts loose plugins into a folder of their own', () => {
    expect(placed(vh, ['X.dll', 'README.md', 'manifest.json', 'icon.png'], 'Cool').files).toEqual({ 'X.dll': 'BepInEx/plugins/Cool/X.dll' });
    expect(placed(vh, ['Cool/X.dll'], 'Cool').files).toEqual({ 'Cool/X.dll': 'BepInEx/plugins/Cool/X.dll' });
    expect(placed(vh, ['plugins/X.dll', 'config/x.cfg'], 'Cool').files).toEqual({ 'plugins/X.dll': 'BepInEx/plugins/Cool/X.dll', 'config/x.cfg': 'BepInEx/config/x.cfg' });
    expect(placed(vh, ['plugins/Cool/X.dll'], 'Cool').files).toEqual({ 'plugins/Cool/X.dll': 'BepInEx/plugins/Cool/X.dll' });
  });

  it('unpacks the loader itself into the game folder', () => {
    const { files } = placed(vh, ['BepInExPack/winhttp.dll', 'BepInExPack/doorstop_config.ini', 'BepInExPack/BepInEx/core/BepInEx.dll']);
    expect(files).toEqual({ 'BepInExPack/winhttp.dll': 'winhttp.dll', 'BepInExPack/doorstop_config.ini': 'doorstop_config.ini', 'BepInExPack/BepInEx/core/BepInEx.dll': 'BepInEx/core/BepInEx.dll' });
  });
});

describe('checking a staged mod', () => {
  it('tells a mod the game cannot find from one in place', () => {
    expect(checkStaged(cp, ['Option A/archive/pc/mod/a.archive']).broken).toBe(true);
    expect(checkStaged(cp, ['a.archive']).broken).toBe(true);
    expect(checkStaged(cp, ['archive/pc/mod/a.archive', `${CET}/x/init.lua`]).broken).toBe(false);
    expect(checkStaged(sk, ['MyMod/meshes/a.nif', 'MyMod/x.esp']).broken).toBe(true);
    expect(checkStaged(sk, ['meshes/a.nif', 'x.esp', `${GAME_ROOT}/skse64_loader.exe`])).toMatchObject({ broken: false, misplaced: [] });
    expect(checkStaged(sv, ['manifest.json', 'Mod.dll']).broken).toBe(true);
    expect(checkStaged(sv, ['Mod/manifest.json', 'Mod/Mod.dll']).broken).toBe(false);
    expect(checkStaged(vh, ['plugins/X.dll']).broken).toBe(true);
    expect(checkStaged(vh, ['BepInEx/plugins/X.dll', 'winhttp.dll']).broken).toBe(false);
  });
});
