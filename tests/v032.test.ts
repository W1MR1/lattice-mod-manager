import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { removeVortexLeftovers, vortexDeployedFiles } from '../electron/core/importers';
import { gameDef } from '../electron/core/games';
import { checkCompatibility } from '../electron/core/compat';
import { gameLaunchTarget, installMinecraftLoader } from '../electron/core/launch';
import type { JarMeta } from '../electron/core/jarmeta';
import { Service } from '../electron/core/service';
import { violatesStrict } from '../shared/versions';
import { installed, profile, ver } from './fixtures';

const tmp = (p: string) => fs.mkdtemp(path.join(os.tmpdir(), `lattice-${p}-`));
async function write(file: string, body = 'x') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
}
const exists = (p: string) => fs.stat(p).then(
  () => true,
  () => false,
);

describe('Vortex leftovers after Vortex is gone', () => {
  it('counts only files that are really there, and puts the game back the way Vortex would on Purge', async () => {
    const game = await tmp('vxgone');
    await write(path.join(game, 'valheim.exe'));
    const manifest = path.join(game, 'vortex.deployment.json');
    const files = ['BepInEx/plugins/A.dll', 'BepInEx/plugins/B.dll', 'BepInEx/config/x.cfg'].map((relPath) => ({ relPath, source: 'A', time: 1 }));
    await write(manifest, JSON.stringify({ version: 1, instance: 'x', stagingPath: path.join(game, 'gone'), targetPath: game, files }));
    // the user deleted the files by hand: the list alone must not block anything
    expect(await vortexDeployedFiles(game, gameDef('valheim')!)).toBe(0);

    await write(path.join(game, 'BepInEx', 'plugins', 'A.dll'), 'mod');
    await write(path.join(game, 'BepInEx', 'config', 'x.cfg'), 'mod');
    await write(path.join(game, 'BepInEx', 'config', 'x.cfg.vortex_backup'), 'original');
    await write(path.join(game, 'BepInEx', 'plugins', 'Mine.dll'), 'not from Vortex');
    expect(await vortexDeployedFiles(game, gameDef('valheim')!)).toBe(2);

    const quarantine = path.join(await tmp('vxq'), 'q');
    const r = await removeVortexLeftovers(game, gameDef('valheim')!, quarantine);
    expect(r).toEqual({ removed: 2, restored: 1, failed: [] });
    expect(await exists(path.join(game, 'BepInEx', 'plugins', 'A.dll'))).toBe(false);
    // nothing is lost: the file waits in the quarantine under its path in the game
    expect(await fs.readFile(path.join(quarantine, 'BepInEx', 'plugins', 'A.dll'), 'utf8')).toBe('mod');
    expect(await fs.readFile(path.join(game, 'BepInEx', 'config', 'x.cfg'), 'utf8')).toBe('original');
    expect(await fs.readFile(path.join(game, 'BepInEx', 'plugins', 'Mine.dll'), 'utf8')).toBe('not from Vortex');
    expect(await exists(manifest)).toBe(false);
    expect(await exists(`${manifest}.lattice-old`)).toBe(true);
    expect(await vortexDeployedFiles(game, gameDef('valheim')!)).toBe(0);
  });

  it('offers the cleanup in the integrity check and unblocks deploying', async () => {
    const home = await tmp('vxhealth');
    const game = path.join(home, 'Valheim');
    await write(path.join(game, 'valheim.exe'));
    await write(path.join(game, 'BepInEx', 'plugins', 'A.dll'), 'mod');
    await write(path.join(game, 'vortex.deployment.json'), JSON.stringify({ version: 1, instance: 'x', targetPath: game, files: [{ relPath: 'BepInEx/plugins/A.dll', source: 'A', time: 1 }] }));
    const svc = new Service(path.join(home, 'state.json'), path.join(home, 'data'));
    const g = await svc.addGame('valheim', game);
    const p = svc.state().profiles.find((x) => x.gameId === g.id)!;
    const staged = path.join(home, 'staged', 'b');
    await write(path.join(staged, 'BepInEx', 'plugins', 'B.dll'), 'lattice mod');
    const mod = installed(ver('b', '1.0', { gameVersions: [], loaders: [] }), { stagedPath: staged });
    svc.store.state.profiles.find((x) => x.id === p.id)!.mods[mod.key] = mod;
    await expect(svc.deploy(p.id)).rejects.toThrow(/Vortex/);
    const problems = await svc.healthCheck();
    const vx = problems.find((x) => x.id === `vortex:${g.id}`);
    expect(vx).toBeTruthy();
    const r = await svc.repair([vx!.id]);
    expect(r.failed).toEqual([]);
    expect(await exists(path.join(game, 'BepInEx', 'plugins', 'A.dll'))).toBe(false);
    // the repair deploys the profile right away
    expect(await fs.readFile(path.join(game, 'BepInEx', 'plugins', 'B.dll'), 'utf8')).toBe('lattice mod');
    await expect(svc.deploy(p.id)).resolves.toMatchObject({ failed: [] });
  });
});

describe('versions that do not fit the profile', () => {
  it('reads Maven and semver ranges and never flags what it cannot read', () => {
    expect(violatesStrict('1.21.1', '[1.20.1,1.21)')).toBe(true);
    expect(violatesStrict('1.20.4', '[1.20.1,1.21)')).toBe(false);
    expect(violatesStrict('1.21.1', '[1.21,)')).toBe(false);
    expect(violatesStrict('1.21.1', '[1.20.1]')).toBe(true);
    expect(violatesStrict('1.21.1', '~1.20')).toBe(true);
    expect(violatesStrict('1.21.1', '>=1.21')).toBe(false);
    expect(violatesStrict('1.21.1', '*')).toBe(false);
    expect(violatesStrict('1.21.1', 'whatever')).toBe(false);
    expect(violatesStrict(undefined, '~1.20')).toBe(false);
  });

  it('catches a jar made for another Minecraft version or loader even without source metadata', () => {
    const local = installed(ver('oldmod', '1.0', { gameVersions: [], loaders: [] }), { key: 'local:oldmod', ref: { source: 'local', projectId: 'oldmod' } });
    const remote = installed(ver('forgemod', '1.0', { gameVersions: [], loaders: [] }));
    const fine = installed(ver('okmod', '1.0', { gameVersions: [], loaders: [] }));
    const p = profile([local, remote, fine]);
    const jars = new Map<string, JarMeta>([
      [local.key, { ids: ['oldmod'], versions: {}, depends: [{ id: 'minecraft', range: '~1.20' }], breaks: [], loaders: ['fabric'] }],
      [remote.key, { ids: ['forgemod'], versions: {}, depends: [{ id: 'minecraft', range: '[1.21,)' }], breaks: [], loaders: ['forge', 'neoforge'] }],
      [fine.key, { ids: ['okmod'], versions: {}, depends: [{ id: 'minecraft', range: '>=1.21' }], breaks: [], loaders: ['fabric'] }],
    ]);
    const issues = checkCompatibility(p, [], [], undefined, jars).issues;
    const game = issues.filter((i) => i.code === 'incompatible-game');
    const loader = issues.filter((i) => i.code === 'incompatible-loader');
    expect(game.map((i) => i.subject)).toEqual([local.key]);
    // a local file cannot be swapped for another version: no fix button
    expect(game[0].fix).toBeUndefined();
    expect(loader.map((i) => i.subject)).toEqual([remote.key]);
    expect(loader[0].fix).toMatchObject({ kind: 'update', key: remote.key });
    expect(issues.some((i) => i.subject === fine.key)).toBe(false);
  });
});

describe('starting Minecraft', () => {
  it('explains a Minecraft version Fabric does not know instead of "400 Bad Request: []"', async () => {
    const dir = await tmp('mc400');
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('[]', { status: 400, statusText: 'Bad Request' })) as typeof fetch;
    try {
      const e = await installMinecraftLoader(dir, '26.1-snapshot-9', 'fabric', 'p', 'x').catch((x: Error) => x);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toContain('Fabric');
      expect((e as Error).message).toContain('26.1-snapshot-9');
      expect((e as Error).message).not.toContain('400');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('starts the exe the user chose before anything it finds itself', async () => {
    const dir = await tmp('custom');
    await write(path.join(dir, 'StardewModdingAPI.exe'));
    const exe = path.join(dir, 'MyLauncher.exe');
    expect(await gameLaunchTarget(gameDef('stardewvalley')!, dir, { store: 'steam', launcherExe: exe, customExe: true })).toEqual({ kind: 'exe', path: exe });
    // a found launcher without the user's choice does not take over
    expect(await gameLaunchTarget(gameDef('stardewvalley')!, dir, { store: 'steam', launcherExe: exe })).toMatchObject({ path: path.join(dir, 'StardewModdingAPI.exe') });
  });
});

describe('disk hygiene', () => {
  it('frees only what no profile or snapshot uses', async () => {
    const home = await tmp('disk');
    const data = path.join(home, 'data');
    const svc = new Service(path.join(home, 'state.json'), data);
    const kept = path.join(data, 'staging', 'g1', 'modrinth_kept', 'v1');
    const orphan = path.join(data, 'staging', 'g1', 'modrinth_orphan', 'v1');
    const shared = path.join(data, 'staging', '_shared', 'pack', 'file.jar');
    const oldImport = path.join(data, 'staging', '_import', 'abc', 'x.zip');
    const download = path.join(data, 'downloads', 'ab', 'abcdef', 'orphan.jar');
    await write(path.join(kept, 'mods', 'kept.jar'), 'kept');
    await write(path.join(orphan, 'mods', 'orphan.jar'), 'orphan!');
    await write(shared, 'shared');
    await write(oldImport, 'import');
    await write(download, 'download');
    svc.store.state.profiles.push(profile([installed(ver('kept', '1.0'), { stagedPath: kept, files: [] })], { id: 'disk-p' }));

    const u = await svc.diskUsage();
    expect(u.unusedCount).toBe(3);
    expect(u.unused).toBe('orphan!'.length + 'import'.length + 'download'.length);
    const r = await svc.freeUnused();
    expect(r).toEqual({ removed: 3, freed: u.unused });
    expect(await exists(path.join(kept, 'mods', 'kept.jar'))).toBe(true);
    expect(await exists(shared)).toBe(true);
    expect(await exists(orphan)).toBe(false);
    expect(await exists(path.dirname(orphan))).toBe(false); // the empty mod folder goes too
    expect(await exists(path.dirname(download))).toBe(false);
    expect((await svc.diskUsage()).unusedCount).toBe(0);
  });
});
