// Installing real archives end to end: from a zip on disk to files in a game folder.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { path7za } from '7zip-bin';
import { describe, expect, it } from 'vitest';
import { Service } from '../electron/core/service';
import type { InstalledMod } from '../shared/types';

const tmp = (p: string) => fs.mkdtemp(path.join(os.tmpdir(), `lattice-${p}-`));
async function write(file: string, body = 'x') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
}
const exists = (p: string) =>
  fs.stat(p).then(
    () => true,
    () => false,
  );
/** Packs files (archive path -> content) into a zip named `name`. */
async function zip(name: string, files: Record<string, string>): Promise<string> {
  const src = await tmp('zsrc');
  for (const [rel, body] of Object.entries(files)) await write(path.join(src, rel), body);
  const out = path.join(await tmp('zout'), name);
  execFileSync(path7za, ['a', '-tzip', out, '*'], { cwd: src, windowsHide: true });
  return out;
}
const CET = 'bin/x64/plugins/cyber_engine_tweaks/mods';

async function cyberpunk() {
  const home = await tmp('cp');
  const game = path.join(home, 'Cyberpunk 2077');
  await write(path.join(game, 'bin', 'x64', 'Cyberpunk2077.exe'));
  const svc = new Service(path.join(home, 'state.json'), path.join(home, 'data'));
  const toasts: string[] = [];
  svc.on('toast', (t) => toasts.push(t.text));
  const g = await svc.addGame('cyberpunk2077', game);
  const mods = () => Object.values(svc.state().profiles.find((p) => p.id === g.activeProfileId)!.mods);
  return { home, game, svc, g, profileId: g.activeProfileId, mods, toasts };
}

describe('Cyberpunk 2077: archives packed every which way end up where the game reads them', () => {
  it('unwraps a wrapper folder, places loose files, and says what it did', async () => {
    const { game, svc, profileId, mods } = await cyberpunk();
    const a = await zip('Wrapped.zip', { 'Wrapped/archive/pc/mod/a.archive': 'A', 'Wrapped/readme.txt': 'r' });
    const b = await zip('Loose-777-1-0-1700000000.zip', { 'loose.archive': 'L', 'Tool/init.lua': 'lua' });
    const plan = await svc.importLocal(profileId, [a, b]);
    expect(await svc.inspectPlan(plan.id)).toEqual({ fomod: [], layout: [] });
    await svc.applyPlan(plan.id);
    expect(await fs.readFile(path.join(game, 'archive', 'pc', 'mod', 'a.archive'), 'utf8')).toBe('A');
    expect(await fs.readFile(path.join(game, 'archive', 'pc', 'mod', 'loose.archive'), 'utf8')).toBe('L');
    expect(await exists(path.join(game, CET, 'Tool', 'init.lua'))).toBe(true);
    expect(await exists(path.join(game, 'readme.txt'))).toBe(false);
    expect(await exists(path.join(game, 'Wrapped'))).toBe(false);
    expect(mods().find((m) => m.title === 'Wrapped')?.installNotes?.length).toBeGreaterThan(0);
  });

  it('asks which variant to install, remembers the answer, and lets it be changed', async () => {
    const { game, svc, profileId, mods } = await cyberpunk();
    const arc = await zip('Variants.zip', { 'Option A/archive/pc/mod/a.archive': 'A', 'Option B/archive/pc/mod/b.archive': 'B' });
    const plan = await svc.importLocal(profileId, [arc]);
    const prompts = await svc.inspectPlan(plan.id);
    expect(prompts.layout).toHaveLength(1);
    expect(prompts.layout[0]).toMatchObject({ reason: 'variants', choice: { roots: ['Option A/'] } });
    expect(prompts.layout[0].options.map((o) => o.path)).toEqual(['Option A/', 'Option B/']);
    const key = prompts.layout[0].key;
    await svc.applyPlan(plan.id, false, {}, { [key]: { roots: ['Option B/'] } });
    const mod = () => mods().find((m) => m.key === key)!;
    expect(await exists(path.join(game, 'archive', 'pc', 'mod', 'b.archive'))).toBe(true);
    expect(await exists(path.join(game, 'archive', 'pc', 'mod', 'a.archive'))).toBe(false);
    expect(mod()).toMatchObject({ layout: { roots: ['Option B/'] }, extraVariants: 1 });

    // the mod card: every part of the archive on offer, the current one ticked
    const again = await svc.layoutPrompt(profileId, key);
    expect(again?.choice.roots).toEqual(['Option B/']);
    expect(again?.options.map((o) => o.path)).toEqual(expect.arrayContaining(['Option A/', 'Option B/']));
    await svc.reinstallWithLayout(profileId, key, { roots: ['Option A/'] });
    expect(await exists(path.join(game, 'archive', 'pc', 'mod', 'a.archive'))).toBe(true);
    expect(await exists(path.join(game, 'archive', 'pc', 'mod', 'b.archive'))).toBe(false);

    // a collection made from the profile installs the same variant without asking
    const c = svc.createCollection(profileId, { name: 'Lock', version: '1.0.0', author: '', description: '' });
    expect(c.mods.find((m) => m.title === 'Variants')?.layout).toEqual({ roots: ['Option A/'] });
  });

  it('installs the suggested variant when nobody can be asked, and says so', async () => {
    const { game, svc, profileId, toasts } = await cyberpunk();
    const arc = await zip('Parts.zip', { 'Main/archive/pc/mod/main.archive': 'M', 'Optional patch/archive/pc/mod/patch.archive': 'P' });
    const plan = await svc.importLocal(profileId, [arc]);
    const res = await svc.applyPlan(plan.id);
    expect(res.warnings.join(' ')).toMatch(/Main/);
    expect(await exists(path.join(game, 'archive', 'pc', 'mod', 'main.archive'))).toBe(true);
    expect(await exists(path.join(game, 'archive', 'pc', 'mod', 'patch.archive'))).toBe(false);
    expect(toasts.join('\n')).toMatch(/Main/);
  });

  it('puts an unrecognised archive where the user says', async () => {
    const { game, svc, profileId } = await cyberpunk();
    const arc = await zip('Plugin.zip', { 'plugin.dll': 'D', 'plugin.cfg': 'c' });
    const plan = await svc.importLocal(profileId, [arc]);
    const { layout } = await svc.inspectPlan(plan.id);
    expect(layout[0].reason).toBe('unknown');
    await svc.applyPlan(plan.id, false, {}, { [layout[0].key]: { roots: [''], dest: 'red4ext/plugins/{mod}' } });
    expect(await exists(path.join(game, 'red4ext', 'plugins', 'Plugin', 'plugin.dll'))).toBe(true);
  });

  it('finds mods laid out wrong by an older version and lays them out again', async () => {
    const { home, game, svc, profileId } = await cyberpunk();
    const arc = await zip('Old.zip', { 'Old/archive/pc/mod/old.archive': 'O' });
    // the way 0.3 staged it: the archive as it was, wrapper and all
    const staged = path.join(home, 'data', 'staging', 'g', 'local_old', 'v1');
    await write(path.join(staged, 'Old', 'archive', 'pc', 'mod', 'old.archive'), 'O');
    await write(path.join(staged, '.lattice-complete'), '2026-11-01');
    const st = await fs.stat(arc);
    const mod: InstalledMod = {
      key: 'local:old',
      ref: { source: 'local', projectId: 'old' },
      title: 'Old',
      versionId: 'v1',
      version: '1.0',
      gameVersions: [],
      loaders: [],
      enabled: true,
      reason: 'explicit',
      requiredBy: [],
      deps: [],
      files: [{ url: pathToFileURL(arc).href, filename: 'Old.zip', size: st.size, hashes: {}, primary: true }],
      stagedPath: staged,
      installedAt: '2026-11-01T00:00:00Z',
    };
    svc.store.state.profiles.find((p) => p.id === profileId)!.mods[mod.key] = mod;
    const before = await svc.compat(profileId);
    const issue = before.issues.find((i) => i.code === 'misplaced');
    expect(issue).toMatchObject({ severity: 'error', subject: 'local:old', fix: { kind: 'restage' } });
    expect(before.score).toBeLessThan(100);
    await svc.applyFix(profileId, issue!.fix!);
    expect(await fs.readFile(path.join(game, 'archive', 'pc', 'mod', 'old.archive'), 'utf8')).toBe('O');
    expect((await svc.compat(profileId)).issues.filter((i) => i.code === 'misplaced')).toEqual([]);
  });

  it('tells which framework a mod is written for when it is missing', async () => {
    const { game, svc, profileId } = await cyberpunk();
    const arc = await zip('Cet Tool.zip', { 'CetTool/init.lua': 'lua' });
    const scripts = await zip('Scripts.zip', { 'r6/scripts/thing/a.reds': 'reds' });
    const plan = await svc.importLocal(profileId, [arc, scripts]);
    await svc.applyPlan(plan.id);
    const needs = (await svc.compat(profileId)).issues.filter((i) => i.code === 'needs-framework');
    expect(needs.map((i) => i.fix?.ref?.projectId).sort()).toEqual(['jac3km4/redscript', 'yamashi/CyberEngineTweaks']);
    // installed by hand, outside Lattice: that counts
    await write(path.join(game, 'bin', 'x64', 'plugins', 'cyber_engine_tweaks.asi'));
    await write(path.join(game, 'engine', 'config', 'base', 'scripts.ini'));
    expect((await svc.compat(profileId)).issues.filter((i) => i.code === 'needs-framework')).toEqual([]);
  });
});

describe('Skyrim: files for the game folder and files for Data', () => {
  it('installs a script extender archive to both places and takes it all out again', async () => {
    const home = await tmp('sk');
    const game = path.join(home, 'Skyrim Special Edition');
    await write(path.join(game, 'SkyrimSE.exe'));
    await write(path.join(game, 'Data', 'Skyrim.esm'));
    const svc = new Service(path.join(home, 'state.json'), path.join(home, 'data'));
    const g = await svc.addGame('skyrimse', game);
    const arc = await zip('skse64_2_02_06.zip', { 'skse64_2_02_06/skse64_loader.exe': 'L', 'skse64_2_02_06/skse64_1_6_1170.dll': 'D', 'skse64_2_02_06/Data/Scripts/a.pex': 'P', 'skse64_2_02_06/src/x.cpp': 'c' });
    const plugin = await zip('Plugin.zip', { 'SKSE/Plugins/plugin.dll': 'd' });
    const plan = await svc.importLocal(g.activeProfileId, [plugin]);
    await svc.applyPlan(plan.id);
    expect((await svc.compat(g.activeProfileId)).issues.map((i) => i.code)).toContain('needs-framework');
    const plan2 = await svc.importLocal(g.activeProfileId, [arc]);
    await svc.applyPlan(plan2.id, true);
    expect(await fs.readFile(path.join(game, 'skse64_loader.exe'), 'utf8')).toBe('L');
    expect(await fs.readFile(path.join(game, 'Data', 'Scripts', 'a.pex'), 'utf8')).toBe('P');
    expect(await exists(path.join(game, 'Data', 'skse64_loader.exe'))).toBe(false);
    expect(await exists(path.join(game, 'src'))).toBe(false);
    expect((await svc.compat(g.activeProfileId)).issues.map((i) => i.code)).not.toContain('needs-framework');
    await svc.purge(g.id);
    expect(await exists(path.join(game, 'skse64_loader.exe'))).toBe(false);
    expect(await exists(path.join(game, 'Data', 'Scripts', 'a.pex'))).toBe(false);
    expect(await exists(path.join(game, 'Data', 'Skyrim.esm'))).toBe(true);
  });
});

describe('Stardew Valley: what manifest.json asks for', () => {
  it('reports a content pack whose framework mod is missing', async () => {
    const home = await tmp('sv');
    const game = path.join(home, 'Stardew Valley');
    await write(path.join(game, 'Stardew Valley.exe'));
    await write(path.join(game, 'StardewModdingAPI.exe'));
    const svc = new Service(path.join(home, 'state.json'), path.join(home, 'data'));
    const g = await svc.addGame('stardewvalley', game);
    const pack = await zip('Pack.zip', { 'manifest.json': '{\n  // a comment, as authors write them\n  "Name": "Pack", "UniqueID": "me.pack",\n  "ContentPackFor": { "UniqueID": "Pathoschild.ContentPatcher" },\n}' });
    const plan = await svc.importLocal(g.activeProfileId, [pack]);
    await svc.applyPlan(plan.id);
    expect(await exists(path.join(game, 'Mods', 'Pack', 'manifest.json'))).toBe(true);
    const missing = (await svc.compat(g.activeProfileId)).issues.filter((i) => i.code === 'jar-dependency');
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toContain('Pathoschild.ContentPatcher');
    const cp = await zip('ContentPatcher.zip', { 'ContentPatcher/manifest.json': '{ "Name": "Content Patcher", "UniqueID": "Pathoschild.ContentPatcher" }' });
    const plan2 = await svc.importLocal(g.activeProfileId, [cp]);
    await svc.applyPlan(plan2.id);
    expect((await svc.compat(g.activeProfileId)).issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});

describe('Minecraft: a zip is told by what is inside it', () => {
  it('takes jars out of a wrapping zip and sends a shader pack to shaderpacks', async () => {
    const home = await tmp('mc');
    const inst = path.join(home, 'mc');
    await write(path.join(inst, 'launcher_profiles.json'), '{"profiles":{}}');
    const svc = new Service(path.join(home, 'state.json'), path.join(home, 'data'));
    const g = await svc.addGame('minecraft', inst, { gameVersion: '1.21.1', loader: 'fabric' });
    const wrapped = await zip('release.zip', { 'cool-mod-1.0.jar': 'JAR', 'cool-mod-1.0-sources.jar': 'SRC', 'README.md': 'r' });
    const shader = await zip('Shader.zip', { 'shaders/final.fsh': 'void main(){}' });
    const plan = await svc.importLocal(g.activeProfileId, [wrapped, shader]);
    await svc.applyPlan(plan.id, true);
    expect(await fs.readFile(path.join(inst, 'mods', 'cool-mod-1.0.jar'), 'utf8')).toBe('JAR');
    expect(await exists(path.join(inst, 'mods', 'cool-mod-1.0-sources.jar'))).toBe(false);
    expect(await exists(path.join(inst, 'shaderpacks', 'Shader.zip'))).toBe(true);
    expect(await exists(path.join(inst, 'resourcepacks', 'release.zip'))).toBe(false);
  });
});

describe('Cyberpunk 2077: two variants packed as loose files with the same names', () => {
  it('asks which one, and the game folder gets the one picked — not whichever came last in the archive', async () => {
    const { game, svc, profileId, mods } = await cyberpunk();
    const file = await zip('Hair Pack.zip', { '4K/hair.archive': 'four', '2K/hair.archive': 'two', 'readme.txt': 'r' });
    const plan = await svc.importLocal(profileId, [file]);
    const asked = await svc.inspectPlan(plan.id);
    expect(asked.layout).toHaveLength(1);
    expect(asked.layout[0]).toMatchObject({ reason: 'variants' });
    expect(asked.layout[0].options.map((o) => o.path).sort()).toEqual(['2K/', '4K/']);
    await svc.applyPlan(plan.id, false, {}, { [asked.layout[0].key]: { roots: ['4K/'] } });
    expect(await fs.readFile(path.join(game, 'archive', 'pc', 'mod', 'hair.archive'), 'utf8')).toBe('four');
    // the other variant stays one click away
    const m = mods()[0];
    expect(m.layout).toEqual({ roots: ['4K/'] });
    await svc.reinstallWithLayout(profileId, m.key, { roots: ['2K/'] });
    expect(await fs.readFile(path.join(game, 'archive', 'pc', 'mod', 'hair.archive'), 'utf8')).toBe('two');
  });

  it('installed without anyone to ask, it takes one variant and says so', async () => {
    const { game, svc, profileId, toasts } = await cyberpunk();
    const file = await zip('Hair Pack.zip', { '4K/hair.archive': 'four', '2K/hair.archive': 'two' });
    const plan = await svc.importLocal(profileId, [file]);
    await svc.applyPlan(plan.id);
    expect(['four', 'two']).toContain(await fs.readFile(path.join(game, 'archive', 'pc', 'mod', 'hair.archive'), 'utf8'));
    expect(toasts.join('\n')).toMatch(/вариант|variant/i);
  });
});
