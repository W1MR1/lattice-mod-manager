// What the game's own logs say about the mods: the parsers, and how their
// facts become problems of a profile. The samples here were written from
// memory of the formats; gamelog-real.test.ts holds the ones built from the
// loaders' own source, and is the one to trust and to extend.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { path7za } from '7zip-bin';
import { describe, expect, it } from 'vitest';
import { logFindings, parseBepInExLog, parseCetLog, parseFabricLog, parseForgeLog, parseRed4extLog, parseRedscriptLog, parseSkseLog, parseSmapiLog, type ReadLog } from '../electron/core/gamelog';
import { Service } from '../electron/core/service';

const FABRIC = `[12:00:00] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.15.11
[12:00:01] [main/INFO]: Loading 5 mods:
\t- fabric-api 0.92.2+1.20.1
\t   |-- fabric-api-base 0.4.31+1802ada577
\t   \\-- fabric-transfer-api-v1 3.3.5+8dd72ea377
\t- fabricloader 0.15.11
\t- java 17
\t- minecraft 1.20.1
\t- sodium 0.5.8+mc1.20.1
[12:00:02] [main/INFO]: SpongePowered MIXIN Subsystem Version=0.8.5`;

const FABRIC_BROKEN = `[12:00:00] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.15.11
[12:00:01] [main/ERROR]: Incompatible mods found!
net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!
A potential solution has been determined, this may resolve your problem:
\t - Install fabric-api, any version.
More details:
\t - Mod 'Indium' (indium) 1.0.27+mc1.20.1 requires version 0.5.3 or later of mod 'Sodium' (sodium), but only the wrong version is present: 0.4.10!
\t - Mod 'Mod Menu' (modmenu) 7.2.2 requires any version of fabric-api, which is missing!`;

describe('reading loader logs', () => {
  it('Fabric: the list of loaded mods without what they bundle, and why the loader refused to start', () => {
    const ok = parseFabricLog(FABRIC)!;
    expect(ok).toMatchObject({ loader: 'Fabric', complete: true, failed: [] });
    expect(ok.loaded).toEqual(['fabric-api', 'fabricloader', 'java', 'minecraft', 'sodium']);
    const bad = parseFabricLog(FABRIC_BROKEN)!;
    expect(bad.fatal).toBeTruthy();
    expect(bad.failed.map((f) => f.id)).toEqual(['indium', 'modmenu']);
    expect(bad.failed[1].reason).toContain('fabric-api');
    expect(parseFabricLog('[12:00] [main/INFO]: Setting user: someone')).toBeNull();
  });

  it('Quilt: the table of mods', () => {
    const q = parseFabricLog(`[main/INFO]: Loading Minecraft 1.20.1 with Quilt Loader 0.26.0
[main/INFO]: Loading 2 mods:
| Index | Mod       | ID        | Version |
|------:|-----------|-----------|---------|
|     0 | Minecraft | minecraft | 1.20.1  |
|     1 | Sodium    | sodium    | 0.5.8   |
[main/INFO]: done`)!;
    expect(q).toMatchObject({ loader: 'Quilt', loaded: ['minecraft', 'sodium'] });
  });

  it('Forge: mod files found and missing dependencies', () => {
    const f = parseForgeLog(`[main/INFO] [cp.mo.mo.Launcher/MODLAUNCHER]: ModLauncher running: args [--fml.forgeVersion, 47.3.0]
[main/DEBUG] [ne.mi.fm.lo.mo.ModFileParser/LOADING]: Found valid mod file create-1.20.1-0.5.1.f.jar with {create,flywheel} mods - versions {0.5.1.f,0.6.10}
[main/ERROR] [ne.mi.fm.lo.ModSorter/LOADING]: Missing or unsupported mandatory dependencies:
\tMod ID: 'geckolib', Requested by: 'mowziesmobs', Expected range: '[4.2,)', Actual version: '[MISSING]'`)!;
    expect(f.loader).toBe('Forge');
    expect(f.loaded).toEqual(['create', 'flywheel']);
    expect(f.failed).toEqual([{ id: 'mowziesmobs', reason: 'requires geckolib [4.2,), which is missing' }]);
  });

  it('BepInEx: plugins loaded and plugins skipped', () => {
    const b = parseBepInExLog(`[Message:   BepInEx] BepInEx 5.4.22.0 - valheim
[Info   :   BepInEx] 2 plugins to load
[Info   :   BepInEx] Loading [Jotunn 2.20.0]
[Error  :   BepInEx] Could not load [Epic Loot 0.9.38] because it has missing dependencies: com.jotunn.jotunn (v2.14.0 or newer)
[Warning:   BepInEx] Skipping [Old Thing 1.0] because a newer version exists (1.1)
[Message:   BepInEx] Chainloader startup complete`)!;
    expect(b.loaded).toEqual(['jotunn']);
    expect(b.failed).toEqual([{ id: 'epic loot', reason: 'it has missing dependencies: com.jotunn.jotunn (v2.14.0 or newer)' }]);
  });

  it('SMAPI: mods, content packs and the skipped ones', () => {
    const s = parseSmapiLog(`[12:00:00 INFO  SMAPI] SMAPI 4.0.8 with Stardew Valley 1.6.8 on Microsoft Windows 11 Pro
[12:00:01 INFO  SMAPI] Loaded 1 mods:
[12:00:01 INFO  SMAPI]    Content Patcher 2.0.6 by Pathoschild | Loads content packs.

[12:00:01 INFO  SMAPI] Loaded 1 content packs:
[12:00:01 INFO  SMAPI]    Seasonal Outfits 6.5 by Poltergeister | for Content Patcher | Outfits.

[12:00:01 ERROR SMAPI] Skipped mods
[12:00:01 ERROR SMAPI] --------------------------------------------------
[12:00:01 ERROR SMAPI]    These mods could not be added to your game.
[12:00:01 ERROR SMAPI]       - Pack 1.0 because it needs mods which aren't installed (spacechase0.JsonAssets).
[12:00:02 INFO  SMAPI] Launching mods...`)!;
    expect(s.loaded).toEqual(['content patcher', 'seasonal outfits']);
    expect(s.failed).toEqual([{ id: 'pack', reason: "it needs mods which aren't installed (spacechase0.JsonAssets)." }]);
  });

  it('Cyberpunk: RED4ext plugins, CET mods and redscript errors', () => {
    const r = parseRed4extLog(`[2026-11-01 12:00:00.000] [RED4ext] [info] RED4ext (v1.27.0) is initializing...
[2026-11-01 12:00:00.100] [RED4ext] [info] ArchiveXL (version: 1.21.0, author(s): psiberx) has been loaded
[2026-11-01 12:00:00.200] [RED4ext] [warning] OldPlugin (version: 1.0) is incompatible with the current patch. The requested runtime of the plugin is 2.12, the current runtime is 2.31
[2026-11-01 12:00:00.300] [RED4ext] [warning] The plugin located at 'C:\\Games\\Cyberpunk 2077\\red4ext\\plugins\\Broken\\Broken.dll' could not be loaded. Error code: 126`)!;
    expect(r.loaded).toEqual(['archivexl']);
    expect(r.failed.map((f) => f.id)).toEqual(['oldplugin', 'broken']);
    const c = parseCetLog(`[2026-11-01 12:00:01 UTC+03:00] [info] CET version v1.35.0 [HEAD]
[2026-11-01 12:00:02 UTC+03:00] [info] Mod Tool loaded! ('C:\\Games\\Cyberpunk 2077\\bin\\x64\\plugins\\cyber_engine_tweaks\\mods\\Tool')
[2026-11-01 12:00:02 UTC+03:00] [error] Mod Bad failed to load! ('C:\\Games\\Cyberpunk 2077\\bin\\x64\\plugins\\cyber_engine_tweaks\\mods\\Bad')
[2026-11-01 12:00:09 UTC+03:00] [error] ...ins\\cyber_engine_tweaks\\mods\\Tool\\init.lua:3: attempt to index a nil value`)!;
    expect(c.loaded).toEqual(['tool']);
    // only what CET could not load; an error a loaded mod printed later is its own business
    expect(c.failed.map((f) => f.id)).toEqual(['bad']);
    const s = parseRedscriptLog(`[INFO - Sat, 1 Nov 2026 12:00:00 +0300] Compiling files in C:\\Games\\Cyberpunk 2077\\r6\\scripts
[ERROR - Sat, 1 Nov 2026 12:00:01 +0300] Unresolved reference Foo
 at C:\\Games\\Cyberpunk 2077\\r6\\scripts\\CoolScripts\\main.reds:12:5
[ERROR - Sat, 1 Nov 2026 12:00:01 +0300] REDScript compilation has failed.`)!;
    expect(s.failed.map((f) => f.id)).toEqual(['coolscripts']);
    expect(s.fatal).toBeTruthy();
  });

  it('SKSE: plugins that loaded and plugins that did not', () => {
    const k = parseSkseLog(`SKSE64 runtime: initialize (version = 2.2.6 010611A0 01DB000000000000, os = 10.0 (26100))
plugin directory = C:\\Games\\Skyrim Special Edition\\Data\\SKSE\\Plugins\\
checking plugin C:\\Games\\Skyrim Special Edition\\Data\\SKSE\\Plugins\\Good.dll
plugin Good.dll (00000001 Good 00000001) loaded correctly (handle 1)
plugin Old.dll (00000000  00000000) disabled, incompatible with current runtime version (handle 0)`)!;
    expect(k).toMatchObject({ loader: 'SKSE', loaded: ['good'], failed: [{ id: 'old' }] });
  });
});

describe('from log facts to problems of a profile', () => {
  const log = (text: string, mtime: number): ReadLog => ({ file: 'latest.log', mtime, facts: parseFabricLog(text)! });
  const subjects = [
    { key: 'modrinth:sodium', title: 'Sodium', names: [{ id: 'sodium', loader: 'Fabric' }] },
    { key: 'modrinth:fapi', title: 'Fabric API', names: [{ id: 'fabric-api', loader: 'Fabric' }] },
    { key: 'modrinth:lithium', title: 'Lithium', names: [{ id: 'lithium', loader: 'Fabric' }] },
    { key: 'modrinth:pack', title: 'A resource pack', names: [] },
  ];

  it('tells which mod the game did not load, and leaves alone what it cannot know', () => {
    const { issues, summary } = logFindings([log(FABRIC, 2000)], subjects, 1000);
    expect(summary).toMatchObject({ stale: false, loaded: 5, failed: 0 });
    expect(issues.map((i) => i.subject)).toEqual(['modrinth:lithium']);
    expect(issues[0]).toMatchObject({ severity: 'warning', code: 'not-loaded' });
  });

  it('passes on the reason the loader gave for refusing a mod', () => {
    const more = [...subjects, { key: 'modrinth:indium', title: 'Indium', names: [{ id: 'indium', loader: 'Fabric' }] }];
    const { issues, summary } = logFindings([log(FABRIC_BROKEN, 2000)], more, 1000);
    expect(summary?.fatal).toBeTruthy();
    const indium = issues.find((i) => i.subject === 'modrinth:indium')!;
    expect(indium.severity).toBe('error');
    expect(indium.message).toContain('Sodium');
    // a mod the log names that the profile does not have still gets told
    expect(issues.some((i) => i.subject === 'game:modmenu')).toBe(true);
  });

  it('says nothing about a log written before the mods last changed', () => {
    const { issues, summary } = logFindings([log(FABRIC_BROKEN, 500)], subjects, 1000);
    expect(issues).toEqual([]);
    expect(summary?.stale).toBe(true);
  });

  it('sees that the game ran without the mods of the profile at all', () => {
    const vanilla = `[12:00:00] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.15.11\n[12:00:01] [main/INFO]: Loading 3 mods:\n\t- fabricloader 0.15.11\n\t- java 17\n\t- minecraft 1.20.1\n`;
    const { issues } = logFindings([log(vanilla, 2000)], subjects, 1000);
    expect(issues).toHaveLength(1);
    expect(issues[0].subject).toBe('game:run:Fabric');
  });
});

describe('a Minecraft profile and the log of its last run', () => {
  it('shows a mod the loader left out once the game has run', async () => {
    const tmp = (p: string) => fs.mkdtemp(path.join(os.tmpdir(), `lattice-${p}-`));
    const home = await tmp('mclog');
    const inst = path.join(home, 'mc');
    await fs.mkdir(inst, { recursive: true });
    await fs.writeFile(path.join(inst, 'launcher_profiles.json'), '{"profiles":{}}');
    const svc = new Service(path.join(home, 'state.json'), path.join(home, 'data'));
    const g = await svc.addGame('minecraft', inst, { gameVersion: '1.20.1', loader: 'fabric' });
    const jar = async (id: string) => {
      const src = await tmp('jar');
      await fs.writeFile(path.join(src, 'fabric.mod.json'), JSON.stringify({ id, version: '1.0.0' }));
      const out = path.join(await tmp('jarout'), `${id}-1.0.0.jar`);
      execFileSync(path7za, ['a', '-tzip', out, '*'], { cwd: src, windowsHide: true });
      return out;
    };
    const plan = await svc.importLocal(g.activeProfileId, [await jar('sodium'), await jar('lithium'), await jar('iris'), await jar('indium')]);
    await svc.applyPlan(plan.id, true);
    expect((await svc.compat(g.activeProfileId)).log).toBeUndefined();
    // the game runs: its log is newer than the last change of the mods folder
    await fs.mkdir(path.join(inst, 'logs'), { recursive: true });
    const text = FABRIC.replace('Loading 5 mods:', 'Loading 8 mods:').replace('\t- sodium', '\t- indium 1.0.0\n\t- iris 1.0.0\n\t- sodium');
    await fs.writeFile(path.join(inst, 'logs', 'latest.log'), text);
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(inst, 'logs', 'latest.log'), later, later);
    const report = await svc.compat(g.activeProfileId);
    expect(report.log).toMatchObject({ stale: false, loaders: ['Fabric'] });
    const notLoaded = report.issues.filter((i) => i.code === 'not-loaded');
    expect(notLoaded.map((i) => i.message).join(' ')).toMatch(/lithium/i);
    expect(notLoaded).toHaveLength(1);
  });
});
