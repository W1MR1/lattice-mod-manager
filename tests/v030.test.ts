import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { path7za } from '7zip-bin';
import { deploy, deployDrift, purge } from '../electron/core/deployer';
import { detectAll, inspectFolder, parseVersionId, type DetectEnv } from '../electron/core/detect';
import { gameLaunchTarget, installMinecraftLoader } from '../electron/core/launch';
import { gameDef } from '../electron/core/games';
import { jarMetaOfBuffer, parseModsToml, type JarMeta } from '../electron/core/jarmeta';
import { checkCompatibility } from '../electron/core/compat';
import { gbVersions } from '../electron/core/sources/gamebanana';
import { cfToVersion } from '../electron/core/sources/curseforge';
import { verify } from '../electron/core/downloader';
import { Store } from '../electron/core/store';
import { Service } from '../electron/core/service';
import { matchesStrict } from '../shared/versions';
import type { InstalledMod } from '../shared/types';
import { installed, profile, ver } from './fixtures';

const tmp = (p: string) => fs.mkdtemp(path.join(os.tmpdir(), `lattice-${p}-`));
async function write(file: string, body: string | Buffer = 'x') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
}

async function stagedMod(key: string, files: Record<string, string>): Promise<InstalledMod> {
  const dir = await tmp('staged');
  for (const [rel, body] of Object.entries(files)) await write(path.join(dir, rel), body);
  return installed(ver(key, '1.0'), { key: `modrinth:${key}`, stagedPath: dir });
}

describe('deployment keeps track of what it could not change', () => {
  it('reports a file it cannot remove, keeps it in the manifest and removes it next time', async () => {
    const root = await tmp('game');
    const data = await tmp('data');
    const a = await stagedMod('a', { 'mods/a.jar': 'A' });
    const opts = { root, order: [a.key], mods: { [a.key]: a }, manifestPath: path.join(data, 'manifest.json'), backupDir: path.join(data, 'backup'), method: 'copy' as const };
    expect((await deploy(opts)).failed).toEqual([]);
    // the game holds the file: here a folder in its place makes the removal fail
    await fs.rm(path.join(root, 'mods', 'a.jar'));
    await write(path.join(root, 'mods', 'a.jar', 'held'));
    const off = { ...opts, mods: { [a.key]: { ...a, enabled: false } } };
    const r = await deploy(off);
    expect(r.failed?.map((f) => f.rel)).toEqual(['mods/a.jar']);
    expect((await deployDrift(off)).stale).toEqual(['mods/a.jar']);
    // the game is closed: the next run removes it
    await fs.rm(path.join(root, 'mods', 'a.jar'), { recursive: true });
    await write(path.join(root, 'mods', 'a.jar'), 'A');
    expect((await deploy(off)).failed).toEqual([]);
    expect(await fs.stat(path.join(root, 'mods', 'a.jar')).catch(() => null)).toBeNull();
  });

  it('purge keeps the manifest while files remain and restores game files', async () => {
    const root = await tmp('game');
    const data = await tmp('data');
    await write(path.join(root, 'Data', 'Skyrim.ini'), 'original');
    const a = await stagedMod('a', { 'Data/Skyrim.ini': 'modded', 'Data/a.esp': 'esp' });
    const manifestPath = path.join(data, 'manifest.json');
    await deploy({ root, order: [a.key], mods: { [a.key]: a }, manifestPath, backupDir: path.join(data, 'backup'), method: 'copy' });
    await fs.rm(path.join(root, 'Data', 'a.esp'));
    await write(path.join(root, 'Data', 'a.esp', 'held'));
    const r1 = await purge(manifestPath, root, path.join(data, 'backup'));
    expect(r1.failed.map((f) => f.rel)).toEqual(['Data/a.esp']);
    expect(await fs.readFile(path.join(root, 'Data', 'Skyrim.ini'), 'utf8')).toBe('original');
    expect(await fs.stat(manifestPath).catch(() => null)).not.toBeNull();
    await fs.rm(path.join(root, 'Data', 'a.esp'), { recursive: true });
    const r2 = await purge(manifestPath, root, path.join(data, 'backup'));
    expect(r2.failed).toEqual([]);
    expect(await fs.stat(manifestPath).catch(() => null)).toBeNull();
  });

  it('a manifest written for another folder owns nothing in this one', async () => {
    const oldRoot = await tmp('old');
    const newRoot = await tmp('new');
    const data = await tmp('data');
    const a = await stagedMod('a', { 'mods/a.jar': 'A' });
    const opts = { order: [a.key], mods: { [a.key]: a }, manifestPath: path.join(data, 'm.json'), backupDir: path.join(data, 'b'), method: 'copy' as const };
    await deploy({ ...opts, root: oldRoot });
    await write(path.join(newRoot, 'mods', 'a.jar'), 'the user’s own file');
    await deploy({ ...opts, root: newRoot, mods: {} });
    expect(await fs.readFile(path.join(newRoot, 'mods', 'a.jar'), 'utf8')).toBe('the user’s own file');
  });
});

function fakeEnv(home: string, extra: Partial<DetectEnv> = {}): DetectEnv {
  return {
    home,
    appData: path.join(home, 'AppData', 'Roaming'),
    localAppData: path.join(home, 'AppData', 'Local'),
    programData: path.join(home, 'ProgramData'),
    programFiles: [path.join(home, 'Program Files')],
    drives: [],
    steamLibraries: async () => [],
    gogPaths: async () => [],
    ...extra,
  };
}

describe('launchers and stores', () => {
  it('finds Prism instances, Legacy Launcher folders and official installations with their versions', async () => {
    const home = await tmp('home');
    const env = fakeEnv(home);
    const prism = path.join(env.appData, 'PrismLauncher');
    await write(path.join(prism, 'prismlauncher.cfg'), 'InstanceDir=instances\n');
    await write(path.join(prism, 'instances', 'Fab 1.21', 'instance.cfg'), 'name=Fabric pack\n');
    await write(
      path.join(prism, 'instances', 'Fab 1.21', 'mmc-pack.json'),
      JSON.stringify({ components: [{ uid: 'net.minecraft', version: '1.21.1' }, { uid: 'net.fabricmc.fabric-loader', version: '0.16.9' }] }),
    );
    await fs.mkdir(path.join(prism, 'instances', 'Fab 1.21', 'minecraft'), { recursive: true });
    const legacy = path.join(env.appData, '.tlauncher', 'legacy', 'Minecraft');
    await fs.mkdir(path.join(legacy, 'versions'), { recursive: true });
    await fs.mkdir(path.join(legacy, 'home', 'Fabric-1.20.1'), { recursive: true });
    const dotMc = path.join(env.appData, '.minecraft');
    const sep = path.join(home, 'mc-forge');
    await fs.mkdir(sep, { recursive: true });
    await write(path.join(dotMc, 'launcher_profiles.json'), JSON.stringify({ profiles: { a: { name: 'Forge pack', gameDir: sep, lastVersionId: '1.20.1-forge-47.3.0' } } }));

    const all = await detectAll(env);
    const mc = all.filter((d) => d.defId === 'minecraft');
    const prismCopy = mc.find((d) => d.via === 'prism')!;
    expect(prismCopy).toMatchObject({ label: 'Fabric pack', gameVersion: '1.21.1', loader: 'fabric', install: { instanceId: 'Fab 1.21' } });
    expect(prismCopy.path).toBe(path.join(prism, 'instances', 'Fab 1.21', 'minecraft'));
    expect(mc.filter((d) => d.via === 'legacy').map((d) => path.basename(d.path))).toEqual(['Minecraft', 'Fabric-1.20.1']);
    expect(mc.find((d) => d.path === path.join(legacy, 'home', 'Fabric-1.20.1'))).toMatchObject({ gameVersion: '1.20.1', loader: 'fabric', install: { launcherRoot: path.resolve(legacy) } });
    expect(mc.find((d) => d.path === sep)).toMatchObject({ via: 'official', label: 'Forge pack', loader: 'forge', gameVersion: '1.20.1' });

    // picking the instance folder itself lands on its game folder
    const picked = await inspectFolder('minecraft', path.join(prism, 'instances', 'Fab 1.21'), env);
    expect(picked.path).toBe(prismCopy.path);
    expect(picked.install.launcher).toBe('prism');
  });

  it('recognises a game by its executable in Steam, Epic and other folders', async () => {
    const home = await tmp('home');
    const steamLib = path.join(home, 'Steam');
    await write(path.join(steamLib, 'steamapps', 'common', 'Stardew Valley', 'Stardew Valley.exe'));
    const epicDir = path.join(home, 'Epic', 'Cyberpunk 2077');
    await write(path.join(epicDir, 'bin', 'x64', 'Cyberpunk2077.exe'));
    await fs.mkdir(path.join(epicDir, '.egstore'), { recursive: true });
    const env = fakeEnv(home, { steamLibraries: async () => [steamLib] });
    await write(
      path.join(env.programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests', 'x.item'),
      JSON.stringify({ InstallLocation: epicDir, AppName: 'Ginger', CatalogNamespace: 'ns', CatalogItemId: 'item' }),
    );
    const all = await detectAll(env);
    expect(all.find((d) => d.defId === 'stardewvalley')).toMatchObject({ via: 'steam' });
    expect(all.find((d) => d.defId === 'cyberpunk2077')).toMatchObject({ via: 'epic', install: { epicId: 'ns:item:Ginger' } });

    const t1 = await gameLaunchTarget(gameDef('cyberpunk2077')!, epicDir, { store: 'epic', epicId: 'ns:item:Ginger' });
    expect(t1).toEqual({ kind: 'url', url: 'com.epicgames.launcher://apps/ns%3Aitem%3AGinger?action=launch&silent=true' });
    const gogDir = await tmp('gog');
    await write(path.join(gogDir, 'Stardew Valley.exe'));
    expect(await gameLaunchTarget(gameDef('stardewvalley')!, gogDir, { store: 'gog' })).toEqual({ kind: 'exe', path: path.join(gogDir, 'Stardew Valley.exe') });
    // SMAPI starts the game when it is there
    await write(path.join(gogDir, 'StardewModdingAPI.exe'));
    expect(await gameLaunchTarget(gameDef('stardewvalley')!, gogDir, { store: 'gog' })).toMatchObject({ path: path.join(gogDir, 'StardewModdingAPI.exe') });
    await expect(gameLaunchTarget(gameDef('valheim')!, gogDir, { store: 'xbox' })).rejects.toThrow();
  });

  it('reads game versions and loaders from launcher version ids', () => {
    expect(parseVersionId('fabric-loader-0.16.9-1.21.1')).toEqual({ loader: 'fabric', gameVersion: '1.21.1' });
    expect(parseVersionId('quilt-loader-0.26.4-1.20.1')).toEqual({ loader: 'quilt', gameVersion: '1.20.1' });
    expect(parseVersionId('1.20.1-forge-47.3.0')).toEqual({ loader: 'forge', gameVersion: '1.20.1' });
    expect(parseVersionId('neoforge-21.1.77')).toEqual({ loader: 'neoforge', gameVersion: '1.21.1' });
    expect(parseVersionId('Fabric 1.19.2')).toEqual({ loader: 'fabric', gameVersion: '1.19.2' });
  });

  it('puts a loader version into a launcher folder without launcher_profiles.json (Legacy Launcher)', async () => {
    const dir = await tmp('legacy');
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) =>
      new Response(JSON.stringify(String(url).endsWith('/profile/json') ? { id: 'fabric-loader-0.16.9-9.9.8' } : [{ loader: { version: '0.16.9', stable: true } }]))) as typeof fetch;
    try {
      const r = await installMinecraftLoader(dir, '9.9.8', 'fabric', 'p', 'x');
      expect(r).toMatchObject({ versionId: 'fabric-loader-0.16.9-9.9.8', profileName: '' });
      expect(await fs.stat(path.join(dir, 'versions', r.versionId, `${r.versionId}.json`))).toBeTruthy();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

async function jar(files: Record<string, string | Buffer>): Promise<Buffer> {
  const src = await tmp('jarsrc');
  for (const [rel, body] of Object.entries(files)) await write(path.join(src, rel), body);
  const out = path.join(await tmp('jarout'), 'x.jar');
  execFileSync(path7za, ['a', '-tzip', out, '*'], { cwd: src, windowsHide: true });
  return fs.readFile(out);
}

describe('what mod jars declare', () => {
  it('reads Fabric descriptors with bundled jars and Forge mods.toml', async () => {
    const inner = await jar({ 'fabric.mod.json': JSON.stringify({ id: 'cloth-config', version: '15.0.0' }) });
    const outer = await jar({
      'fabric.mod.json': JSON.stringify({ id: 'mymod', version: '1.0.0', depends: { 'fabric-api': '*', minecraft: '~1.21', 'cloth-config': '>=15' }, breaks: { sodium: '<0.6' } }),
      'META-INF/jars/cloth.jar': inner,
    });
    const m = jarMetaOfBuffer(outer);
    expect(m.ids.sort()).toEqual(['cloth-config', 'mymod']);
    expect(m.versions['cloth-config']).toBe('15.0.0');
    expect(m.depends.map((d) => d.id).sort()).toEqual(['cloth-config', 'fabric-api', 'minecraft']);
    expect(m.breaks).toEqual([{ id: 'sodium', range: '<0.6' }]);

    const toml = parseModsToml(`modLoader="javafml"\n[[mods]]\nmodId="create"\nversion="6.0"\n[[dependencies.create]]\n    modId="neoforge"\n    type="required"\n[[dependencies.create]]\n    modId="flywheel"\n    type="required"\n    versionRange="[1.0,)"\n[[dependencies.create]]\n    modId="jei"\n    type="optional"\n[[dependencies.create]]\n    modId="badmod"\n    type="incompatible"\n`);
    expect(toml.ids).toEqual(['create']);
    expect(toml.depends.map((d) => d.id)).toEqual(['neoforge', 'flywheel']);
    expect(toml.breaks.map((d) => d.id)).toEqual(['badmod']);
  });

  it('turns missing jar dependencies and real conflicts into issues, without false alarms', () => {
    const a = installed(ver('mymod', '1.0'));
    const b = installed(ver('sodium', '0.5'));
    const p = profile([a, b]);
    const jars = new Map<string, JarMeta>([
      [a.key, { ids: ['mymod'], versions: { mymod: '1.0.0' }, depends: [{ id: 'fabric-api' }, { id: 'minecraft' }, { id: 'java' }], breaks: [{ id: 'sodium', range: '<0.6' }] }],
      [b.key, { ids: ['sodium'], versions: { sodium: '0.5.13' }, depends: [], breaks: [{ id: 'iris', range: '<1.8.13' }] }],
    ]);
    const r = checkCompatibility(p, [], [], undefined, jars);
    expect(r.issues.filter((i) => i.code === 'jar-dependency').map((i) => i.message)).toHaveLength(1);
    expect(r.issues.find((i) => i.code === 'jar-dependency')?.fix).toMatchObject({ kind: 'install', ref: { source: 'modrinth', projectId: 'fabric-api' } });
    expect(r.issues.filter((i) => i.code === 'jar-breaks')).toHaveLength(1);
    // a newer sodium is outside the range: no conflict
    jars.get(b.key)!.versions.sodium = '0.6.1';
    expect(checkCompatibility(p, [], [], undefined, jars).issues.some((i) => i.code === 'jar-breaks')).toBe(false);
    expect(matchesStrict('1.8.14-beta.1+mc1.21.1', '<1.8.13')).toBe(false);
    expect(matchesStrict(undefined, '<1.0')).toBe(false);
    expect(matchesStrict('2.0', 'not a range')).toBe(false);
  });
});

describe('new sources', () => {
  it('maps GameBanana files to versions with MD5, leaving out archived and flagged files', () => {
    const v = gbVersions({ source: 'gamebanana', projectId: '1' }, {
      _idRow: 1,
      _sName: 'Mod',
      _aFiles: [
        { _idRow: 10, _sFile: 'old.zip', _tsDateAdded: 100, _sDownloadUrl: 'https://gamebanana.com/dl/10', _sMd5Checksum: 'AA' },
        { _idRow: 11, _sFile: 'new.zip', _tsDateAdded: 200, _sDownloadUrl: 'https://gamebanana.com/dl/11', _sMd5Checksum: 'bb', _sVersion: '2.0' },
        { _idRow: 12, _sFile: 'bad.zip', _tsDateAdded: 300, _sDownloadUrl: 'https://gamebanana.com/dl/12', _sAvResult: 'infected' },
        { _idRow: 13, _sFile: 'gone.zip', _tsDateAdded: 400, _sDownloadUrl: 'https://gamebanana.com/dl/13', _bIsArchived: true },
      ],
    });
    expect(v.map((x) => x.versionId)).toEqual(['11', '10']);
    expect(v[0]).toMatchObject({ version: '2.0', files: [{ url: 'https://gamebanana.com/dl/11', hashes: { md5: 'bb' } }] });
    expect(v[1].files[0].hashes).toEqual({ md5: 'aa' });
  });

  it('maps CurseForge files: versions, loaders, relations, and files the author keeps on the site', () => {
    const v = cfToVersion({ source: 'curseforge', projectId: '5' }, {
      id: 99,
      displayName: 'Mod 1.2',
      fileName: 'mod-1.2.jar',
      fileDate: '2026-01-01T00:00:00Z',
      downloadUrl: 'https://edge.forgecdn.net/files/1/99/mod-1.2.jar',
      hashes: [
        { value: 'abc', algo: 1 },
        { value: 'def', algo: 2 },
      ],
      gameVersions: ['1.20.1', 'Fabric', 'Client', 'Quilt'],
      dependencies: [
        { modId: 7, relationType: 3 },
        { modId: 8, relationType: 2 },
        { modId: 9, relationType: 5 },
        { modId: 10, relationType: 6 },
      ],
    });
    expect(v).toMatchObject({ gameVersions: ['1.20.1'], loaders: ['fabric', 'quilt'], files: [{ hashes: { sha1: 'abc', md5: 'def' } }] });
    expect(v.deps.map((d) => `${d.kind}:${d.ref.projectId}`)).toEqual(['requires:7', 'recommends:8', 'conflicts:9']);
    expect(cfToVersion({ source: 'curseforge', projectId: '5' }, { id: 1, displayName: 'x', fileName: 'x.jar', fileDate: '', downloadUrl: null }).files).toEqual([]);
  });

  it('checks MD5 when it is the only hash a source gives', async () => {
    const f = path.join(await tmp('md5'), 'a.zip');
    await fs.writeFile(f, 'hello');
    const md5 = createHash('md5').update('hello').digest('hex');
    expect(await verify(f, { md5 })).toBe('md5');
    await expect(verify(f, { md5: '0'.repeat(32) })).rejects.toThrow();
  });
});

describe('settings, backups and exports', () => {
  it('offers hosts of new sources to existing users once', async () => {
    const dir = await tmp('store');
    const file = path.join(dir, 'state.json');
    await fs.writeFile(file, JSON.stringify({ settings: { trustedHosts: ['cdn.modrinth.com', 'my.host'] } }));
    const s1 = new Store(file, dir);
    expect(s1.state.settings.trustedHosts).toEqual(expect.arrayContaining(['my.host', 'gamebanana.com', 'forgecdn.net']));
    s1.state.settings.trustedHosts = s1.state.settings.trustedHosts.filter((h) => h !== 'gamebanana.com');
    await s1.flush();
    const s2 = new Store(file, dir);
    expect(s2.state.settings.trustedHosts).not.toContain('gamebanana.com');
  });

  it('backs up without secrets and restores games, profiles and preferences', async () => {
    const dir = await tmp('svc');
    const game = await tmp('mc');
    const a = new Service(path.join(dir, 'a.json'), path.join(dir, 'data'));
    a.updateSettings({ theme: 'light', githubToken: 'secret-token', curseforgeKey: 'cf-key' });
    const g = await a.addGame('minecraft', game, { gameVersion: '1.21.1', loader: 'fabric' });
    const file = path.join(dir, 'backup.json');
    const count = await a.backupAll(file);
    expect(count).toMatchObject({ games: 1, profiles: 1 });
    const text = await fs.readFile(file, 'utf8');
    expect(text).not.toContain('secret-token');
    expect(text).not.toContain('cf-key');

    const b = new Service(path.join(dir, 'b.json'), path.join(dir, 'data-b'));
    b.updateSettings({ githubToken: 'mine' });
    await expect(b.restoreBackup(path.join(dir, 'b.json.missing'))).rejects.toThrow();
    const r = await b.restoreBackup(file);
    expect(r).toEqual({ games: 1, profiles: 1 });
    const st = b.state();
    expect(st.games[0]).toMatchObject({ id: g.id, installPath: g.installPath });
    expect(st.games[0].install).toBeUndefined();
    expect(st.settings.theme).toBe('light');
    expect(st.settings.githubToken).toBe('••••'); // the restoring user's own token stays

    const out = path.join(dir, 'profile.json');
    await b.exportProfile(st.games[0].activeProfileId, out);
    expect(JSON.parse(await fs.readFile(out, 'utf8'))).toMatchObject({ schema: 'lattice.collection/1', game: { defId: 'minecraft', gameVersion: '1.21.1' } });
  });
});
