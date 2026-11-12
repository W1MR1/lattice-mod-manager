// The loaders' logs as the loaders themselves write them. Every sample is built
// from the format strings of the loader's own source, named beside it — the
// samples of gamelog.test.ts were written from memory, and five of them were
// wrong in ways that made working mods look broken.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gameDef } from '../electron/core/games';
import { logFindings, parseBepInExLog, parseCetLog, parseFabricLog, parseRed4extLog, parseSkseLog, parseSmapiLog, readGameLogs, type LogSubject } from '../electron/core/gamelog';

/** FabricLoaderImpl.dumpModList0: "\t- id ver"; nested: ("   | " or "     ") per level, then "   |-- id ver" or "   \-- id ver". */
const FABRIC_NESTED = [
  '[20:00:00] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.16.10',
  '[20:00:01] [main/INFO]: Loading 9 mods:',
  '\t- alpha 1.0.0',
  '\t   |-- cloth-config 11.1.136',
  '\t   |    \\-- cloth-basic-math 0.6.1',
  '\t   \\-- mixinextras 0.4.1',
  '\t        |-- deeper-one 1.0.0',
  '\t        \\-- deeper-two 1.0.0',
  '\t- beta 2.0.0',
  '\t- fabricloader 0.16.10',
  '\t- minecraft 1.20.1',
  '\t- zeta 3.0.0',
  '[20:00:02] [main/INFO]: SpongePowered MIXIN Subsystem Version=0.8.7',
].join('\n');

describe('Fabric', () => {
  it('reads the whole list when a bundled library bundles another one', () => {
    const f = parseFabricLog(FABRIC_NESTED)!;
    expect(f.complete).toBe(true);
    // before the fix the list ended at "cloth-basic-math": beta and zeta were "not loaded"
    expect(f.loaded).toEqual(['alpha', 'beta', 'fabricloader', 'minecraft', 'zeta']);
    expect(f.bundled).toEqual(['cloth-config', 'cloth-basic-math', 'mixinextras', 'deeper-one', 'deeper-two']);
  });

  it('does not call a mod missing when it was loaded, at the top or inside another mod', () => {
    const subjects: LogSubject[] = ['alpha', 'beta', 'zeta', 'cloth-config'].map((id) => ({ key: `modrinth:${id}`, title: id, names: [{ id, loader: 'Fabric' }] }));
    const { issues } = logFindings([{ file: 'latest.log', mtime: 2000, facts: parseFabricLog(FABRIC_NESTED)! }], subjects, 1000);
    expect(issues).toEqual([]);
  });

  it('a hundred mods after a deep library are all seen', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `mod${String(i).padStart(3, '0')}`);
    const text = ['[main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.16.10', '[main/INFO]: Loading 102 mods:', '\t- aaa 1.0', '\t   |-- lib 1.0', '\t   |    |-- lib-a 1.0', '\t   |    \\-- lib-b 1.0', '\t   \\-- other 1.0', ...ids.map((id) => `\t- ${id} 1.0`), '[main/INFO]: done'].join('\n');
    const f = parseFabricLog(text)!;
    expect(f.loaded).toHaveLength(101);
    const subjects: LogSubject[] = ids.map((id) => ({ key: `modrinth:${id}`, title: id, names: [{ id, loader: 'Fabric' }] }));
    expect(logFindings([{ file: 'latest.log', mtime: 2000, facts: f }], subjects, 1000).issues).toEqual([]);
  });

  it('a conflict the game starts with is not a failure; a missing requirement is', () => {
    // Messages.properties: resolution.conflicts.invalid, resolution.depends.missing, resolution.breaks.invalid
    const f = parseFabricLog(
      [
        '[main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.16.10',
        '[main/WARN]: Warnings were found!',
        "\t - Mod 'Sodium Extra' (sodium-extra) 0.5.4 conflicts with any version of mod 'Reese's Sodium Options' (reeses-sodium-options), which is present with the following version: 1.7.2!",
        "\t - Mod 'Mod Menu' (modmenu) 7.2.2 recommends any version of mod 'Something' (something), which is missing!",
        "\t - Mod 'Indium' (indium) 1.0.27 requires version 0.5.3 or later of mod 'Sodium' (sodium), which is missing!",
        "\t - Mod 'Iris' (iris) 1.6.4 is incompatible with any version of mod 'OptiFabric' (optifabric), yet a conflicting version is present: 1.13.0!",
      ].join('\n'),
    )!;
    expect(f.failed.map((x) => x.id)).toEqual(['indium', 'iris']);
  });
});

describe('BepInEx', () => {
  it('a plugin left out because it is for another program of the game is not a failure', () => {
    // Chainloader.cs: "Skipping [{pluginInfo}] because of process filters (...)"
    const b = parseBepInExLog(
      ['[Message:   BepInEx] BepInEx 5.4.2100 - Lethal Company', '[Warning:   BepInEx] Skipping [Dedicated Server Tools 1.0.0] because of process filters (LethalServer)', '[Warning:   BepInEx] Skipping [Twin 1.0.0] because a newer version exists (1.1.0)', '[Error  :   BepInEx] Could not load [Needy 1.0.0] because it has missing dependencies: Other (v1.0.0 or newer)', '[Info   :   BepInEx] Loading [MoreCompany 1.11.0]'].join('\n'),
    )!;
    expect(b.loaded).toEqual(['morecompany']);
    expect(b.failed.map((x) => x.id)).toEqual(['needy']);
  });
});

describe('SMAPI', () => {
  it('reads skipped mods under their indented header, and mods without an author', () => {
    // LogManager.cs: "   Skipped mods", "      These mods could not be added…", "      - Name 1.0 because …", "   Name 1.0[ by Author][ | text]"
    const s = parseSmapiLog(
      [
        '[20:00:00 INFO  SMAPI] SMAPI 4.1.10 with Stardew Valley 1.6.15 on Microsoft Windows 11',
        '[20:00:01 ERROR SMAPI]    Skipped mods',
        '[20:00:01 ERROR SMAPI]    --------------------------------------------------',
        '[20:00:01 ERROR SMAPI]       These mods could not be added to your game.',
        '[20:00:01 ERROR SMAPI] ',
        "[20:00:01 ERROR SMAPI]       - Old Mod 1.0.0 because it's no longer compatible. Please check for a new version at https://smapi.io/mods",
        '[20:00:01 ERROR SMAPI]       - Nameless because its manifest is invalid.',
        '[20:00:01 WARN  SMAPI]    Changed save serializer',
        '[20:00:01 WARN  SMAPI]       - Some Mod',
        '[20:00:02 INFO  SMAPI] Loaded 2 mods:',
        '[20:00:02 INFO  SMAPI]    Content Patcher 2.4.4 by Pathoschild | Loads content packs.',
        '[20:00:02 INFO  SMAPI]    Quiet Mod 1.0.0',
        '',
        '[20:00:03 INFO  SMAPI] Launching mods...',
      ].join('\n'),
    )!;
    expect(s.failed.map((x) => x.id)).toEqual(['old mod', 'nameless']);
    expect(s.failed[0].reason).toContain('no longer compatible');
    expect(s.loaded).toEqual(['content patcher', 'quiet mod']);
  });
});

describe('RED4ext', () => {
  it('knows every way PluginSystem.cpp says a plugin was not loaded', () => {
    const r = parseRed4extLog(
      [
        '[2026-11-10 20:00:00.000] [RED4ext] [info] Loading plugins...',
        "[2026-11-10 20:00:00.100] [RED4ext] [warning] Could not load plugin 'Broken'. Error code: 126, msg: 'The specified module could not be found.', path: 'C:\\Games\\Cyberpunk 2077\\red4ext\\plugins\\Broken\\Broken.dll'",
        '[2026-11-10 20:00:00.200] [RED4ext] [warning] OldPatch (version: 1.0.0) is incompatible with the current patch. The requested runtime of the plugin is 2.12',
        "[2026-11-10 20:00:00.300] [RED4ext] [warning] OldSdk (version: 1.0.0) uses RED4ext.SDK v0.3.0 which is not supported by RED4ext v1.27.0. If you are the plugin's author, recompile the plugin with a newer version of RED4ext.SDK",
        '[2026-11-10 20:00:00.400] [RED4ext] [warning] Crashy did not initialize properly, unloading...',
        "[2026-11-10 20:00:00.500] [RED4ext] [warning] 'Ancient' is using an unsupported API version. API version: 0, path: 'C:\\Games\\Cyberpunk 2077\\red4ext\\plugins\\Ancient\\Ancient.dll'",
        '[2026-11-10 20:00:00.600] [RED4ext] [info] ArchiveXL (version: 1.21.0, author(s): psiberx) has been loaded',
        '[2026-11-10 20:00:00.700] [RED4ext] [info] 1 plugin(s) loaded',
      ].join('\n'),
    )!;
    expect(r.loaded).toEqual(['archivexl']);
    expect(r.failed.map((x) => x.id)).toEqual(['broken', 'oldpatch', 'oldsdk', 'crashy', 'ancient']);
    expect(r.failed[0].reason).toContain('The specified module could not be found');
    expect(r.failed[2].reason).toBe('uses RED4ext.SDK v0.3.0 which is not supported by RED4ext v1.27.0');
  });
});

describe('Cyber Engine Tweaks', () => {
  // ScriptStore.cpp: consoleLogger->info("Mod {} loaded! ('{}')") / error("Mod {} failed to load! ('{}')"), logger "scripting" -> scripting.log
  const SCRIPTING = [
    "[2026-11-10 20:00:05 UTC+03:00] [info] Mod nativeSettings loaded! ('C:\\Games\\Cyberpunk 2077\\bin\\x64\\plugins\\cyber_engine_tweaks\\mods\\nativeSettings')",
    "[2026-11-10 20:00:05 UTC+03:00] [error] Mod BrokenOne failed to load! ('C:\\Games\\Cyberpunk 2077\\bin\\x64\\plugins\\cyber_engine_tweaks\\mods\\BrokenOne')",
    '[2026-11-10 20:10:00 UTC+03:00] [error] ...ugins\\cyber_engine_tweaks\\mods\\nativeSettings\\init.lua:120: attempt to index a nil value',
  ].join('\n');
  // Options.cpp: the default logger writes cyber_engine_tweaks.log; it never lists mods
  const MAIN = ['[2026-11-10 20:00:00 UTC+03:00] [info] [Options::Load] [1234] CET version v1.35.0 [HEAD]', '[2026-11-10 20:00:00 UTC+03:00] [info] [Options::Load] [1234] Game version 2.31'].join('\n');

  it('reads the list of mods from scripting.log', () => {
    const c = parseCetLog(SCRIPTING)!;
    expect(c.loaded).toEqual(['nativesettings']);
    // an error a working mod printed later is not a failure to load
    expect(c.failed).toEqual([{ id: 'brokenone', reason: 'failed to load' }]);
  });

  it("says nothing from CET's own log, which lists no mods", () => {
    expect(parseCetLog(MAIN)).toBeNull();
  });

  it('a mod that loaded after a reload is loaded', () => {
    const c = parseCetLog(["[..] [error] Mod Flaky failed to load! ('x')", '[..] [info] LuaVM: Reloaded all mods!', "[..] [info] Mod Flaky loaded! ('x')"].join('\n'))!;
    expect(c).toMatchObject({ loaded: ['flaky'], failed: [] });
  });

  it('the game folder is read for scripting.log, and installed mods are not called missing', async () => {
    const game = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-cet-'));
    const cet = path.join(game, 'bin', 'x64', 'plugins', 'cyber_engine_tweaks');
    await fs.mkdir(cet, { recursive: true });
    await fs.writeFile(path.join(cet, 'cyber_engine_tweaks.log'), MAIN);
    await fs.writeFile(path.join(cet, 'scripting.log'), SCRIPTING);
    const logs = await readGameLogs(gameDef('cyberpunk2077')!, game);
    expect(logs.map((l) => path.basename(l.file))).toEqual(['scripting.log']);
    const subjects: LogSubject[] = [{ key: 'nexus:a', title: 'Native Settings UI', names: [{ id: 'nativesettings', loader: 'Cyber Engine Tweaks' }] }];
    // the one problem is the mod CET itself could not load; the installed mod is not mentioned
    expect(logFindings(logs, subjects, 0).issues.map((i) => i.subject)).toEqual(['game:brokenone']);
  });
});

describe('SKSE and F4SE', () => {
  it('knows a plugin by its file, whether the log prints the name or the whole path', () => {
    // PluginManager.cpp: "plugin %s (%08X %s %08X) %s (handle %d)" and, on an error, "… %s %d (handle %d)"; older builds print the path and no handle
    const k = parseSkseLog(
      [
        'SKSE64 runtime: initialize (version = 2.0.20 01050610 01DA0C0D1A2B3C4D, os = 6.2 (9200))',
        'plugin directory = C:\\Games\\Skyrim Special Edition\\Data\\SKSE\\Plugins\\',
        'checking plugin C:\\Games\\Skyrim Special Edition\\Data\\SKSE\\Plugins\\\\po3_Tweaks.dll',
        "plugin C:\\Games\\Skyrim Special Edition\\Data\\SKSE\\Plugins\\\\po3_Tweaks.dll (00000001 powerofthree's Tweaks 01120000) loaded correctly",
        'plugin NewStyle.dll (00000001 New Style (beta) 00000001) loaded correctly (handle 2)',
        'plugin Old.dll (00000000  00000000) disabled, incompatible with current version of the game 0 (handle 0)',
        "plugin Missing.dll (00000000  00000000) couldn't load plugin 126 (handle 0)",
      ].join('\n'),
    )!;
    expect(k.loaded).toEqual(['po3_tweaks', 'newstyle']);
    expect(k.failed).toEqual([
      { id: 'old', reason: 'disabled, incompatible with current version of the game' },
      { id: 'missing', reason: "couldn't load plugin" },
    ]);
    const subjects: LogSubject[] = [{ key: 'nexus:p', title: 'powerofthree Tweaks', names: [{ id: 'po3_tweaks', loader: 'SKSE' }] }];
    // the plugin printed with its whole path is loaded: only the two real failures are told
    expect(logFindings([{ file: 'skse64.log', mtime: 10, facts: k }], subjects, 0).issues.map((i) => i.subject)).toEqual(['game:old', 'game:missing']);
  });
});
