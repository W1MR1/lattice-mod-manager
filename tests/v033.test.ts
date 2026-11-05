import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { path7za } from '7zip-bin';
import { removeVortexLeftovers, vortexDeployedFiles } from '../electron/core/importers';
import { gameDef } from '../electron/core/games';
import { Service } from '../electron/core/service';
import type { VersionProvider } from '../electron/core/resolver';
import type { ModVersion, Snapshot } from '../shared/types';
import { whyInstalled } from '../shared/why';
import { installed, profile, ref, ver } from './fixtures';

const tmp = (p: string) => fs.mkdtemp(path.join(os.tmpdir(), `lattice-${p}-`));
async function write(file: string, body: string | Buffer = 'x') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
}
const exists = (p: string) => fs.stat(p).then(
  () => true,
  () => false,
);
async function jar(file: string, fabric: object) {
  const src = await tmp('jarsrc');
  await write(path.join(src, 'fabric.mod.json'), JSON.stringify(fabric));
  await fs.mkdir(path.dirname(file), { recursive: true });
  execFileSync(path7za, ['a', '-tzip', file, '*'], { cwd: src, windowsHide: true });
  return file;
}

describe('Vortex cleanup only takes what is still Vortex', () => {
  it('leaves a file someone put in place of a Vortex file, and takes what matches Vortex', async () => {
    const home = await tmp('vxverify');
    const game = path.join(home, 'Valheim');
    const staging = path.join(home, 'VortexMods');
    const plugins = path.join(game, 'BepInEx', 'plugins');
    await write(path.join(staging, 'A', 'A.dll'), 'vortex copy');
    await write(path.join(staging, 'A', 'B.dll'), 'vortex copy');
    await write(path.join(plugins, 'A.dll'), 'vortex copy'); // the same file Vortex deployed
    await write(path.join(plugins, 'B.dll'), 'the user’s own, longer file'); // put there after Vortex
    // a link of the same file counts even without comparing sizes
    await write(path.join(staging, 'A', 'C.dll'), 'linked');
    await fs.link(path.join(staging, 'A', 'C.dll'), path.join(plugins, 'C.dll'));
    await write(
      path.join(plugins, 'vortex.deployment.json'),
      JSON.stringify({ version: 1, instance: 'x', stagingPath: staging, targetPath: plugins, files: ['A.dll', 'B.dll', 'C.dll'].map((relPath) => ({ relPath, source: 'A', time: 1 })) }),
    );
    expect(await vortexDeployedFiles(game, gameDef('valheim')!)).toBe(2);
    const quarantine = path.join(home, 'q');
    const r = await removeVortexLeftovers(game, gameDef('valheim')!, quarantine);
    expect(r.removed).toBe(2);
    expect(await fs.readFile(path.join(plugins, 'B.dll'), 'utf8')).toBe('the user’s own, longer file');
    expect(await exists(path.join(plugins, 'A.dll'))).toBe(false);
    expect(await exists(path.join(quarantine, 'BepInEx', 'plugins', 'C.dll'))).toBe(true);
  });

  it('without the mod folder, a file changed after Vortex deployed it is not Vortex’s', async () => {
    const game = await tmp('vxtime');
    const plugins = path.join(game, 'BepInEx', 'plugins');
    await write(path.join(plugins, 'Old.dll'), 'vortex');
    await write(path.join(plugins, 'New.dll'), 'mine');
    const deployedAt = Date.now() - 3600_000;
    await fs.utimes(path.join(plugins, 'Old.dll'), new Date(deployedAt - 1000), new Date(deployedAt - 1000));
    await write(
      path.join(plugins, 'vortex.deployment.json'),
      JSON.stringify({ version: 1, instance: 'x', stagingPath: path.join(game, 'gone'), targetPath: plugins, files: ['Old.dll', 'New.dll'].map((relPath) => ({ relPath, source: 'A', time: deployedAt })) }),
    );
    expect(await vortexDeployedFiles(game, gameDef('valheim')!)).toBe(1);
  });
});

describe('quarantine, snapshots and cleaning at start', () => {
  it('counts what only snapshots keep, trims snapshots to the limit, and empties old quarantine at start', async () => {
    const home = await tmp('snaps');
    const data = path.join(home, 'data');
    const svc = new Service(path.join(home, 'state.json'), data);
    const live = path.join(data, 'staging', 'g1', 'modrinth_live', 'v1');
    const old = path.join(data, 'staging', 'g1', 'modrinth_old', 'v1');
    await write(path.join(live, 'mods', 'live.jar'), 'live');
    await write(path.join(old, 'mods', 'old.jar'), 'snapshot!');
    const p = profile([installed(ver('live', '1.0'), { stagedPath: live, files: [] })], { id: 'snap-p' });
    svc.store.state.profiles.push(p);
    const snap = (i: number, stagedPath: string): Snapshot => ({
      id: `s${i}`,
      profileId: p.id,
      label: `#${i}`,
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
      mods: { [`modrinth:m${i}`]: installed(ver(`m${i}`, '1.0'), { stagedPath, files: [] }) },
      rules: [],
      collections: [],
    });
    svc.store.state.snapshots.push(snap(1, live), snap(2, live), snap(3, live), snap(4, live), snap(5, old));

    let u = await svc.diskUsage();
    expect(u.snapshots).toBe('snapshot!'.length);
    expect(u.unusedCount).toBe(0);
    expect((await svc.freeUnused()).removed).toBe(0); // a snapshot still needs it

    svc.updateSettings({ snapshotLimit: 3 });
    expect(svc.state().snapshots.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    u = await svc.diskUsage();
    expect(u.snapshots).toBe(0);
    expect(u.unused).toBe('snapshot!'.length);
    svc.updateSettings({ snapshotLimit: 1 });
    expect(svc.settings.snapshotLimit).toBe(3); // at least three are always kept

    const weekAgo = Date.now() - 8 * 24 * 3600 * 1000;
    await write(path.join(data, 'quarantine', `${weekAgo}-g1`, 'BepInEx', 'a.dll'));
    await write(path.join(data, 'quarantine', `${Date.now()}-g1`, 'BepInEx', 'b.dll'));
    await svc.cleanupOnStart();
    expect(await exists(path.join(data, 'quarantine', `${weekAgo}-g1`))).toBe(false);
    expect((await fs.readdir(path.join(data, 'quarantine'))).length).toBe(1);
    expect(await exists(old)).toBe(false); // what nothing keeps any more is gone too
    expect(await exists(path.join(live, 'mods', 'live.jar'))).toBe(true);
  });
});

describe('versions without metadata are checked by their jar while planning', () => {
  it('leaves out versions whose jar is made for another Minecraft or loader', async () => {
    const home = await tmp('jarplan');
    const inst = path.join(home, 'mc');
    await write(path.join(inst, 'launcher_profiles.json'), JSON.stringify({ profiles: {} }));
    const svc = new Service(path.join(home, 'state.json'), path.join(home, 'data'));
    const g = await svc.addGame('minecraft', inst, { gameVersion: '1.21.1', loader: 'fabric' });
    const files = path.join(home, 'files');
    const v = (version: string, published: string, file: string): ModVersion => ({
      ...ver('ghmod', version, { gameVersions: [], loaders: [], date: published }),
      ref: { source: 'github', projectId: 'me/ghmod' },
      files: [{ url: pathToFileURL(file).href, filename: path.basename(file), hashes: {} }],
    });
    const list = [
      v('3.0', '2026-03-01T00:00:00Z', await jar(path.join(files, 'ghmod-3.0.jar'), { id: 'ghmod', version: '3.0', depends: { minecraft: '>=1.21.4' } })),
      v('2.5', '2026-02-01T00:00:00Z', await jar(path.join(files, 'ghmod-2.5.jar'), { id: 'ghmod', version: '2.5', depends: { minecraft: '~1.21' } })),
      v('2.0', '2026-01-01T00:00:00Z', await jar(path.join(files, 'ghmod-2.0.jar'), { id: 'ghmod', version: '2.0', depends: { minecraft: '1.20.x' } })),
    ];
    // a source that knows nothing about game versions, like GitHub releases
    const fake: VersionProvider = { versions: async () => list, meta: async () => new Map() };
    (svc as unknown as { sources: { provider: () => VersionProvider } }).sources.provider = () => fake;
    const seen = await svc.versions({ source: 'github', projectId: 'me/ghmod' }, g.activeProfileId);
    // 3.0 needs 1.21.4: out; 2.5 fits; 2.0 is older than the first fit and is not read
    expect(seen.map((x) => x.version)).toEqual(['2.5', '2.0']);
    const plan = await svc.planInstall(g.activeProfileId, [{ ref: { source: 'github', projectId: 'me/ghmod' }, title: 'GH mod' }]);
    expect(plan.install.map((i) => i.version.version)).toEqual(['2.5']);
  });

  it('reports a jar made for another loader once the mod is installed (the merged jar data keeps loaders)', async () => {
    const home = await tmp('jarloader');
    const inst = path.join(home, 'mc');
    await write(path.join(inst, 'launcher_profiles.json'), JSON.stringify({ profiles: {} }));
    const svc = new Service(path.join(home, 'state.json'), path.join(home, 'data'));
    const g = await svc.addGame('minecraft', inst, { gameVersion: '1.21.1', loader: 'fabric' });
    const staged = path.join(home, 'staged', 'forgemod');
    const src = await tmp('tomlsrc');
    await write(path.join(src, 'META-INF', 'neoforge.mods.toml'), `modLoader="javafml"\n[[mods]]\nmodId="forgemod"\nversion="1.0"\n`);
    await fs.mkdir(path.join(staged, 'mods'), { recursive: true });
    execFileSync(path7za, ['a', '-tzip', path.join(staged, 'mods', 'forgemod.jar'), '*'], { cwd: src, windowsHide: true });
    const m = installed(ver('forgemod', '1.0', { gameVersions: [], loaders: [] }), { stagedPath: staged });
    svc.store.state.profiles.find((x) => x.id === g.activeProfileId)!.mods[m.key] = m;
    const report = await svc.compat(g.activeProfileId);
    expect(report.issues.find((i) => i.code === 'incompatible-loader' && i.subject === m.key)?.message).toMatch(/neoforge/);
  });
});

describe('why a mod is in the profile', () => {
  it('finds the way through the mods that require it to one you installed', () => {
    const lib = installed(ver('lib', '1.0'), { reason: 'dependency' });
    const mid = installed(ver('mid', '1.0', { requires: ['lib'] }), { reason: 'dependency' });
    const top = installed(ver('top', '1.0', { requires: ['mid'] }));
    const p = profile([lib, mid, top]);
    expect(whyInstalled(lib.key, p)).toEqual([lib.key, mid.key, top.key]);
    expect(whyInstalled(top.key, p)).toBeNull(); // installed by you
    expect(ref('x').source).toBe('modrinth');
  });
});
