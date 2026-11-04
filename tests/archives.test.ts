import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { path7za } from '7zip-bin';
import { extractArchive, listArchive } from '../electron/core/archives';
import { FomodRequired, stageVersion, walk } from '../electron/core/installer';
import { gameDef } from '../electron/core/games';
import type { ModVersion } from '../shared/types';
import { SAMPLE_XML, utf16 } from './fomod.test';

async function tree(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-src-'));
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), body);
  }
  return dir;
}

/** Packs a folder with the bundled 7-Zip: "7z" or "zip". */
async function pack(dir: string, type: '7z' | 'zip'): Promise<string> {
  const out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-arc-')), `mod.${type}`);
  execFileSync(path7za, ['a', `-t${type}`, out, '*'], { cwd: dir, windowsHide: true });
  return out;
}

const version = (filename: string): ModVersion => ({
  ref: { source: 'local', projectId: 'test-mod' },
  versionId: filename,
  version: '1.0',
  gameVersions: [],
  loaders: [],
  published: '',
  files: [{ url: 'file:///x', filename, hashes: {} }],
  deps: [],
});

describe('archives', () => {
  it('loads the RAR decoder and rejects a file that is not a RAR archive', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-rar-'));
    const fake = path.join(dir, 'fake.rar');
    await fs.writeFile(fake, 'definitely not a rar archive');
    await expect(listArchive(fake)).rejects.toThrow();
  });

  it('lists and extracts a .7z through the bundled 7-Zip', async () => {
    const src = await tree({ 'Pack/Data/a.esp': 'A', 'Pack/Data/meshes/m.nif': 'M' });
    const arc = await pack(src, '7z');
    expect((await listArchive(arc)).sort()).toEqual(['Pack/Data/a.esp', 'Pack/Data/meshes/m.nif']);
    const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-out-'));
    const n = await extractArchive(arc, dest, (rel) => rel.replace(/^Pack\/Data\//, ''));
    expect(n).toBe(2);
    expect(await fs.readFile(path.join(dest, 'meshes', 'm.nif'), 'utf8')).toBe('M');
  });

  it('stages a generic mod from .7z, stripping the single top folder', async () => {
    const src = await tree({ 'CoolMod/textures/t.dds': 'T', 'CoolMod/Cool.esp': 'E' });
    const arc = await pack(src, '7z');
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-stage-'));
    const res = await stageVersion(gameDef('skyrimse')!, version('mod.7z'), [arc], staging);
    expect((await walk(res.stagedPath)).sort()).toEqual(['Cool.esp', 'textures/t.dds']);
  });

  it('runs a FOMOD installer: asks first, then installs exactly the chosen files', async () => {
    const src = await tree({
      'MyMod/fomod/ModuleConfig.xml': utf16(SAMPLE_XML),
      'MyMod/core/Core.esp': 'core',
      'MyMod/core/textures/sky.dds': 'sky',
      'MyMod/optA/A.esp': 'light',
      'MyMod/optB/B.esp': 'dark',
      'MyMod/extra/Shadows.esp': 'shadows',
      'MyMod/patches/DarkPatch.esp': 'patch',
    });
    const arc = await pack(src, 'zip');
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-stage-'));
    const def = gameDef('skyrimse')!;

    await expect(stageVersion(def, version('mod.zip'), [arc], staging)).rejects.toBeInstanceOf(FomodRequired);

    const dark = await stageVersion(def, version('mod.zip'), [arc], staging, {
      choices: { Вариант: { Стиль: ['Тёмный'] }, 'Только для тёмного': { Дополнения: ['Тени'] } },
    });
    expect((await walk(dark.stagedPath)).sort()).toEqual(['Core.esp', 'DarkPatch.esp', 'Style.esp', 'extra/Shadows.esp', 'textures/sky.dds']);
    expect(await fs.readFile(path.join(dark.stagedPath, 'Style.esp'), 'utf8')).toBe('dark');

    const light = await stageVersion(def, version('mod.zip'), [arc], staging, { choices: { Вариант: { Стиль: ['Светлый'] } } });
    expect(light.stagedPath).not.toBe(dark.stagedPath); // each selection is its own staging
    expect((await walk(light.stagedPath)).sort()).toEqual(['Core.esp', 'Style.esp', 'textures/sky.dds']);
    expect(await fs.readFile(path.join(light.stagedPath, 'Style.esp'), 'utf8')).toBe('light');
  });
});
