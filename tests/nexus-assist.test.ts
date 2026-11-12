// Nexus without Premium and without a key: the user downloads a file in the
// browser, Lattice takes it from the downloads folder and the install goes on.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { path7za } from '7zip-bin';
import { describe, expect, it } from 'vitest';
import { Service } from '../electron/core/service';
import type { ProjectMeta, VersionProvider } from '../electron/core/resolver';
import { keyOf, type Collection, type ModRef, type ModVersion } from '../shared/types';

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

async function setup() {
  const home = await tmp('nx');
  const game = path.join(home, 'Stardew Valley');
  await write(path.join(game, 'Stardew Valley.exe'));
  await write(path.join(game, 'StardewModdingAPI.exe'));
  const downloads = path.join(home, 'Downloads');
  await fs.mkdir(downloads, { recursive: true });
  const svc = new Service(path.join(home, 'state.json'), path.join(home, 'data'));
  // no network: the collection's own lock is all the planner needs
  (svc as unknown as { sources: { provider: (c: unknown, o?: Map<string, ModVersion[]>) => VersionProvider } }).sources.provider = (_c, overlay) => ({
    versions: async (ref: ModRef) => overlay?.get(keyOf(ref)) ?? [],
    meta: async () => new Map<string, ProjectMeta>(),
  });
  svc.updateSettings({ pickupDir: downloads });
  const g = await svc.addGame('stardewvalley', game);
  // the archive as Nexus would serve it
  const src = await tmp('nxsrc');
  await write(path.join(src, 'Pack', 'manifest.json'), '{ "Name": "Pack", "UniqueID": "me.pack" }');
  const arc = path.join(await tmp('nxarc'), 'Pack-1-1-0-1700000000.zip');
  execFileSync(path7za, ['a', '-tzip', arc, '*'], { cwd: src, windowsHide: true });
  const size = (await fs.stat(arc)).size;
  const c: Collection = {
    schema: 'lattice.collection/1',
    id: 'nexus-pack',
    name: 'Nexus pack',
    version: '1',
    author: '',
    description: '',
    game: { defId: 'stardewvalley' },
    requires: [],
    conflicts: [],
    rules: [],
    createdAt: '2026-11-01T00:00:00Z',
    mods: [{ ref: { source: 'nexus', projectId: 'stardewvalley/1' }, title: 'Pack', versionId: '2', version: '1.0', optional: false, files: [{ url: 'nexus://stardewvalley/1/2', filename: 'Pack-1-1-0-1700000000.zip', size, hashes: {}, primary: true }], deps: [], gameVersions: [], loaders: [] }],
  };
  svc.store.state.collections.push(c);
  const plan = await svc.planCollection(g.activeProfileId, c.id);
  const tick = () => (svc as unknown as { nexusAssist: { tick(): Promise<void> } }).nexusAssist.tick();
  return { svc, g, game, downloads, arc, size, plan, tick };
}

describe('Nexus files for a free account', () => {
  it('lists what the user has to fetch, picks the file up from the downloads folder and goes on', async () => {
    const { svc, game, downloads, arc, plan, tick } = await setup();
    expect(plan.ok).toBe(true);
    const events: string[] = [];
    svc.on('nexus', (e: { needs: { state: string }[] }) => events.push(e.needs.map((n) => n.state).join(',')));
    const needs = await svc.nexusPickup(plan.id, true);
    expect(needs).toMatchObject([{ title: 'Pack', modId: 1, fileId: 2, via: 'browser', state: 'waiting' }]);
    expect(needs[0].page).toBe('https://www.nexusmods.com/stardewvalley/mods/1?tab=files&file_id=2');
    // without the file the install cannot go on, and says what to do
    await expect(svc.applyPlan(plan.id)).rejects.toThrow(/Nexus/);

    // a download still running, another archive, and then the real file under the name a browser gives a second copy
    await write(path.join(downloads, 'Pack-1-1-0-1700000000.zip.crdownload'), 'half');
    await write(path.join(downloads, 'Other-9-1-0-1700000001.zip'), 'other');
    await tick();
    expect(events).toEqual([]);
    await fs.copyFile(arc, path.join(downloads, 'Pack-1-1-0-1700000000 (1).zip'));
    await tick();
    expect(events).toEqual(['found']);
    expect(await exists(path.join(downloads, 'Pack-1-1-0-1700000000 (1).zip'))).toBe(false); // taken, not left lying
    expect(await exists(path.join(downloads, 'Other-9-1-0-1700000001.zip'))).toBe(true);

    expect(await svc.nexusNeeds(plan.id)).toEqual([]);
    await svc.applyPlan(plan.id);
    expect(await exists(path.join(game, 'Mods', 'Pack', 'manifest.json'))).toBe(true);
  });

  it('takes a file the user points at, but not a different one', async () => {
    const { svc, game, arc, plan } = await setup();
    await svc.nexusPickup(plan.id, true);
    const wrong = path.join(await tmp('nxwrong'), 'Pack-1-1-0-1700000000.zip');
    await write(wrong, 'not the same file');
    await expect(svc.nexusProvide(plan.id, 2, wrong)).rejects.toThrow();
    const after = await svc.nexusProvide(plan.id, 2, arc);
    expect(after[0].state).toBe('found');
    expect(await exists(arc)).toBe(true); // the user's own file stays where it was
    await svc.applyPlan(plan.id);
    expect(await exists(path.join(game, 'Mods', 'Pack', 'manifest.json'))).toBe(true);
  });

  it('lets a mod be left out of the plan', async () => {
    const { svc, plan } = await setup();
    await svc.nexusPickup(plan.id, true);
    const left = svc.planDrop(plan.id, ['nexus:stardewvalley/1']);
    expect(left.install).toEqual([]);
    expect(await svc.nexusNeeds(plan.id)).toEqual([]);
    svc.discardPlan(plan.id);
  });
});
