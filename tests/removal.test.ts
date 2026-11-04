import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { path7za } from '7zip-bin';
import { applyRemoval, planRemoval } from '../electron/core/removal';
import { minecraftModIds, scanLeftovers } from '../electron/core/cleanup';
import { checkCompatibility } from '../electron/core/compat';
import { installMinecraftLoader } from '../electron/core/launch';
import { githubQuery } from '../electron/core/sources/github';
import { gameDef } from '../electron/core/games';
import { recomputeLinks } from '../electron/core/links';
import type { Profile } from '../shared/types';
import { installed, profile, ver } from './fixtures';

/** app -> lib -> core, plus "other" that also needs core */
function chain(): Profile {
  const p = profile([
    installed(ver('app', '1.0', { requires: ['lib'] })),
    installed(ver('lib', '1.0', { requires: ['core'] }), { reason: 'dependency' }),
    installed(ver('core', '1.0'), { reason: 'dependency' }),
    installed(ver('other', '1.0', { requires: ['core'] })),
  ]);
  recomputeLinks(p);
  return p;
}

describe('planRemoval / applyRemoval', () => {
  it('takes along only the dependencies nobody else needs', () => {
    const p = chain();
    const plan = planRemoval(p, ['modrinth:app'], { withDeps: true, withDependents: false });
    expect(plan.dependents).toEqual([]);
    expect(plan.deps).toEqual(['modrinth:lib']); // core is still needed by "other"
    const removed = applyRemoval(p, plan, { withDeps: true, withDependents: false });
    expect(removed.sort()).toEqual(['modrinth:app', 'modrinth:lib']);
    expect(Object.keys(p.mods).sort()).toEqual(['modrinth:core', 'modrinth:other']);
  });

  it('keeps dependencies as the user’s own mods when asked to remove only the mod', () => {
    const p = chain();
    const opts = { withDeps: false, withDependents: false };
    applyRemoval(p, planRemoval(p, ['modrinth:app'], opts), opts);
    expect(p.mods['modrinth:lib'].reason).toBe('explicit');
    expect(Object.keys(p.mods)).toHaveLength(3);
  });

  it('reports dependents and removes them only when chosen', () => {
    const p = chain();
    const blocked = planRemoval(p, ['modrinth:core'], { withDeps: true, withDependents: false });
    expect(blocked.dependents.sort()).toEqual(['modrinth:lib', 'modrinth:other']);
    expect(blocked.remove).toEqual(['modrinth:core']);
    const all = planRemoval(p, ['modrinth:core'], { withDeps: true, withDependents: true });
    // lib goes, and app, which needs lib, follows it
    expect(all.remove.sort()).toEqual(['modrinth:app', 'modrinth:core', 'modrinth:lib', 'modrinth:other']);
  });

  it('drops load-order rules that point at removed mods', () => {
    const p = chain();
    p.rules = [{ subject: 'modrinth:other', kind: 'after', other: 'modrinth:app' }];
    const opts = { withDeps: true, withDependents: false };
    applyRemoval(p, planRemoval(p, ['modrinth:app'], opts), opts);
    expect(p.rules).toEqual([]);
  });
});

describe('leftovers', () => {
  it('reads mod ids from Fabric and Forge jars and finds their config files', async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-jar-'));
    await fs.mkdir(path.join(src, 'META-INF'));
    await fs.writeFile(path.join(src, 'fabric.mod.json'), JSON.stringify({ id: 'sodium' }));
    await fs.writeFile(path.join(src, 'META-INF', 'mods.toml'), 'modId="sodiumforge"\nmodId="core"');
    const staged = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-staged-'));
    await fs.mkdir(path.join(staged, 'mods'));
    execFileSync(path7za, ['a', '-tzip', path.join(staged, 'mods', 'sodium.jar'), '*'], { cwd: src, windowsHide: true });
    expect((await minecraftModIds(path.join(staged, 'mods', 'sodium.jar'))).sort()).toEqual(['sodium', 'sodiumforge']);

    const game = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-game-'));
    await fs.mkdir(path.join(game, 'config', 'sodium'), { recursive: true });
    await fs.writeFile(path.join(game, 'config', 'sodium-options.json'), '{}');
    await fs.writeFile(path.join(game, 'config', 'sodiumextra.json'), '{}'); // another mod: must stay
    const mod = installed(ver('sodium', '1.0'), { stagedPath: staged, files: [] });
    const found = await scanLeftovers({
      mods: [mod],
      def: gameDef('minecraft')!,
      installPath: game,
      stagingRoot: path.join(game, 'nothing-staged'),
      cachePathOf: () => '',
      inUse: new Set(),
    });
    expect(found.map((l) => path.basename(l.path)).sort()).toEqual(['sodium', 'sodium-options.json']);
    expect(found.every((l) => l.kind === 'config')).toBe(true);
  });
});

describe('duplicates across sources', () => {
  it('warns when the same mod comes from two sources', () => {
    const a = installed(ver('sodium', '1.0'), { title: 'Sodium' });
    const b = installed(ver('sodium-gh', '1.0'), { key: 'github:x/sodium', ref: { source: 'github', projectId: 'x/sodium' }, title: 'sodium-fabric' });
    const r = checkCompatibility(profile([a, b]), []);
    const dup = r.issues.find((i) => i.code === 'duplicate');
    expect(dup?.fix).toMatchObject({ kind: 'disable' });
    expect(checkCompatibility(profile([a]), []).issues.some((i) => i.code === 'duplicate')).toBe(false);
  });
});

describe('github search', () => {
  it('narrows the query to the game', () => {
    const kw = gameDef('cyberpunk2077')?.github?.keywords;
    expect(kw).toBeTruthy();
    expect(githubQuery('', kw)).toBe(`mod ${kw} in:name,description,topics`);
    expect(githubQuery('archive', kw)).toContain('archive');
  });
});

describe('installMinecraftLoader', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('writes the Fabric version and a launcher profile, keeping a backup', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-mc-'));
    const original = JSON.stringify({ profiles: { keep: { name: 'Mine' } }, settings: {} });
    await fs.writeFile(path.join(dir, 'launcher_profiles.json'), original);
    const id = 'fabric-loader-0.16.9-9.9.9';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = url.endsWith('/profile/json') ? { id, inheritsFrom: '9.9.9' } : [{ loader: { version: '0.17.0-beta.1', stable: false } }, { loader: { version: '0.16.9', stable: true } }];
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const r = await installMinecraftLoader(dir, '9.9.9', 'fabric', 'p1', 'Test');
    expect(r).toMatchObject({ versionId: id, installed: true });
    expect(JSON.parse(await fs.readFile(path.join(dir, 'versions', id, `${id}.json`), 'utf8')).id).toBe(id);
    expect((await fs.stat(path.join(dir, 'versions', id, `${id}.jar`))).size).toBe(0);
    const doc = JSON.parse(await fs.readFile(path.join(dir, 'launcher_profiles.json'), 'utf8'));
    expect(doc.profiles.keep).toEqual({ name: 'Mine' });
    expect(doc.profiles['lattice-p1']).toMatchObject({ lastVersionId: id, type: 'custom', name: 'Lattice · Test' });
    expect(await fs.readFile(path.join(dir, 'launcher_profiles.json.lattice-bak'), 'utf8')).toBe(original);
  });

  it('explains that Forge needs its own installer', async () => {
    await expect(installMinecraftLoader(os.tmpdir(), '1.21.1', 'forge', 'p', 'x')).rejects.toThrow(/установщиком/);
  });
});
