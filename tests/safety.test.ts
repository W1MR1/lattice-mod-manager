// Things that must hold whatever a source, an archive or a log says.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readEntry } from '../electron/core/archives';
import type { DetectEnv } from '../electron/core/detect';
import { gameDef } from '../electron/core/games';
import { stageVersion, walk } from '../electron/core/installer';
import { redactLinks } from '../electron/core/journal';
import { Service } from '../electron/core/service';
import type { ModVersion } from '../shared/types';

const tmp = (p: string) => fs.mkdtemp(path.join(os.tmpdir(), `lattice-${p}-`));

describe('names from outside never lead out of the folders Lattice owns', () => {
  it('a file name with ../ from a source is staged inside the staging folder', async () => {
    const home = await tmp('safe');
    const src = path.join(home, 'payload.esp');
    await fs.writeFile(src, 'x');
    const version: ModVersion = {
      ref: { source: 'github', projectId: 'a/b' },
      versionId: 'v1',
      version: '1',
      gameVersions: [],
      loaders: [],
      published: '2026-01-01T00:00:00Z',
      files: [{ url: 'https://example.invalid/x', filename: '../../../escaped.esp', hashes: {}, primary: true }],
      deps: [],
    };
    const staging = path.join(home, 'staging');
    const res = await stageVersion(gameDef('skyrimse')!, version, [src], staging, { unattended: true });
    expect(res.stagedPath.startsWith(staging)).toBe(true);
    const files = await walk(res.stagedPath);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain('..');
    expect(await fs.stat(path.join(home, 'escaped.esp')).catch(() => null)).toBeNull();
  });

  it('an archive entry that points outside is not read', async () => {
    expect(await readEntry(path.join(os.tmpdir(), 'no-such.zip'), '../../secret.png')).toBeNull();
  });
});

describe('what a journal or a report may carry', () => {
  it('links lose their query: signed downloads, nxm keys', () => {
    expect(redactLinks('GET https://cf-files.nexusmods.com/cdn/1/2/f.zip?md5=abc&expires=1&user_id=42 failed')).toBe('GET https://cf-files.nexusmods.com/cdn/1/2/f.zip?… failed');
    expect(redactLinks('nxm://skyrimspecialedition/mods/1/files/2?key=SECRET&expires=9')).toBe('nxm://skyrimspecialedition/mods/1/files/2?…');
    expect(redactLinks('plain text, no links')).toBe('plain text, no links');
  });

  it('a problem report names no home folder, no key, and no signed link', async () => {
    const home = await tmp('report');
    const env: DetectEnv = { home, appData: path.join(home, 'Roaming'), localAppData: path.join(home, 'Local'), programData: path.join(home, 'PD'), programFiles: [], drives: [], steamLibraries: async () => [], gogPaths: async () => [] };
    const game = path.join(home, 'Games', 'Valheim');
    await fs.mkdir(game, { recursive: true });
    await fs.writeFile(path.join(game, 'valheim.exe'), 'x');
    const svc = new Service(path.join(home, 'state.json'), path.join(home, 'data'), undefined, undefined, undefined, env);
    await svc.addGame('valheim', game);
    svc.updateSettings({ githubToken: 'ghp_THISISASECRETTOKEN', curseforgeKey: '$2a$10$SECRETKEY' });
    svc.note('err', `could not read ${path.join(home, 'Games', 'Valheim', 'x.dll')} from https://example.com/file.zip?token=TOPSECRET`);
    const text = await svc.problemReport();
    expect(text).toContain('Valheim');
    expect(text).toContain('~');
    expect(text).not.toContain(home);
    expect(text).not.toContain('SECRET');
    expect(text).toContain('https://example.com/file.zip?…');
  });
});
