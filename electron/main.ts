import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { listArchive, sevenZip } from './core/archives';
import { Service } from './core/service';

const smoke = process.argv.includes('--smoke');
if (smoke) app.setPath('userData', path.join(os.tmpdir(), `lattice-smoke-${Date.now()}`));
const trace = (msg: string) => {
  if (smoke) void fs.appendFile(path.join(process.cwd(), 'smoke-trace.txt'), `${new Date().toISOString()} ${msg}\n`);
};
trace(`start argv=${process.argv.join(' ')}`);

let win: BrowserWindow | null = null;
let service: Service;

// Only these service methods are reachable from the renderer.
const ALLOWED = new Set<keyof Service>([
  'state', 'gameDefs', 'detectGames', 'minecraftVersions', 'addGame', 'removeGame', 'setActiveGame',
  'createProfile', 'updateProfile', 'deleteProfile', 'switchProfile', 'compat', 'search', 'project', 'versions',
  'planInstall', 'planUpdates', 'planCollection', 'applyFix', 'applyPlan', 'setEnabled', 'dependentsOf', 'removeMod',
  'addRule', 'removeRule', 'setUserLink', 'importLocal', 'createCollection', 'updateCollection', 'relockCollection',
  'deleteCollection', 'exportCollection', 'importCollectionFile', 'importModpack', 'createProfileForCollection',
  'removeCollectionFromProfile', 'deploy', 'purge', 'snapshot', 'rollback', 'deleteSnapshot', 'updateSettings',
  'inspectPlan', 'fomodPrompt', 'reinstallWithChoices', 'pluginOrder', 'setNexusKey', 'clearNexusKey', 'handleNxm',
  'nexusSsoAvailable', 'loginWithNexus',
]);

const OVERLAY = {
  dark: { color: '#0e0f10', symbolColor: '#a9a6a0', height: 40 },
  light: { color: '#f4f2ee', symbolColor: '#5d5952', height: 40 },
};

function send(channel: string, payload: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(`lattice:${channel}`, payload);
}

function fromOurWindow(e: Electron.IpcMainInvokeEvent) {
  return win !== null && e.sender === win.webContents;
}

function registerIpc() {
  ipcMain.handle('lattice:call', async (e, method: string, args: unknown[]) => {
    if (!fromOurWindow(e)) throw new Error('forbidden');
    if (!ALLOWED.has(method as keyof Service)) throw new Error(`Неизвестный метод ${method}`);
    const fn = (service as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
    return fn.apply(service, Array.isArray(args) ? args : []);
  });

  ipcMain.handle('lattice:downloads', (e, action: 'list' | 'pause' | 'resume' | 'cancel' | 'clear', id?: string) => {
    if (!fromOurWindow(e)) throw new Error('forbidden');
    const d = service.downloads;
    if (action === 'pause' && id) d.pause(id);
    if (action === 'resume' && id) d.resume(id);
    if (action === 'cancel' && id) d.cancel(id);
    if (action === 'clear') d.clearFinished();
    return d.list();
  });

  ipcMain.handle('lattice:dialog', async (e, kind: 'folder' | 'files' | 'collection-open' | 'collection-save', defaultName?: string) => {
    if (!fromOurWindow(e) || !win) throw new Error('forbidden');
    if (kind === 'folder') {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    }
    if (kind === 'files') {
      const r = await dialog.showOpenDialog(win, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Моды', extensions: ['zip', 'jar', 'dll', 'esp', 'esm', 'esl', 'pak', 'ba2', 'bsa'] }, { name: 'Все файлы', extensions: ['*'] }],
      });
      return r.canceled ? null : r.filePaths;
    }
    if (kind === 'collection-open') {
      const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Коллекции', extensions: ['json', 'mrpack'] }] });
      return r.canceled ? null : r.filePaths[0];
    }
    const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: 'Коллекция Lattice', extensions: ['json'] }] });
    return r.canceled ? null : r.filePath;
  });

  ipcMain.handle('lattice:external', (e, url: string) => {
    if (!fromOurWindow(e)) throw new Error('forbidden');
    if (/^https:\/\//i.test(url)) return shell.openExternal(url);
  });

  ipcMain.handle('lattice:openPath', async (e, p: string) => {
    if (!fromOurWindow(e)) throw new Error('forbidden');
    const st = await fs.stat(p).catch(() => null);
    if (st?.isDirectory()) return shell.openPath(p);
  });

  ipcMain.handle('lattice:theme', (e, theme: 'dark' | 'light') => {
    if (!fromOurWindow(e) || !win) return;
    if (process.platform === 'win32') win.setTitleBarOverlay(OVERLAY[theme] ?? OVERLAY.dark);
  });
}

async function createWindow() {
  const theme = service.settings.theme;
  win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 1060,
    minHeight: 640,
    backgroundColor: theme === 'light' ? '#f4f2ee' : '#0e0f10',
    title: 'Lattice',
    titleBarStyle: 'hidden',
    titleBarOverlay: OVERLAY[theme],
    show: !smoke,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (ev, url) => {
    const dev = process.env.LATTICE_DEV_URL;
    if (!(dev && url.startsWith(dev)) && !url.startsWith('file://')) ev.preventDefault();
  });
  if (process.env.LATTICE_DEV_URL) await win.loadURL(process.env.LATTICE_DEV_URL);
  else await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

/** Renders each screen offscreen, saves screenshots and exits. Uses a throwaway profile. */
async function runSmoke() {
  if (!win) return;
  const outDir = path.join(process.cwd(), 'smoke');
  await fs.mkdir(outDir, { recursive: true });
  const log: string[] = [];
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  trace('smoke: seeding');
  try {
    const inst = path.join(app.getPath('userData'), 'minecraft-instance');
    await fs.mkdir(inst, { recursive: true });
    const game = await service.addGame('minecraft', inst, { gameVersion: '1.21.1', loader: 'fabric' });
    const profileId = game.activeProfileId;
    const plan = await service.planInstall(profileId, [
      { ref: { source: 'modrinth', projectId: 'YL57xq9U' }, title: 'Iris Shaders' },
      { ref: { source: 'modrinth', projectId: 'mOgUt4GM' }, title: 'Mod Menu' },
    ]);
    log.push(`plan ok=${plan.ok} install=${plan.install.map((i) => `${i.title}@${i.version.version}`).join(', ')} issues=${plan.issues.map((i) => i.message).join(' | ')}`);
    const res = await service.applyPlan(plan.id, true);
    log.push(`applied=${res.applied}`);
    const deployed = await fs.readdir(path.join(inst, 'mods')).catch(() => []);
    log.push(`deployed mods/: ${deployed.join(', ')}`);
    const report = await service.compat(profileId);
    log.push(`compat score=${report.score} errors=${report.errors} warnings=${report.warnings}`);
    for (const d of service.downloads.list()) log.push(`download ${d.filename}: ${d.state} ${d.size}B segs=${d.segments.length} verified=${d.verified}`);

    // Linked collections: «Аддон» builds on «Основа»; applying the addon must bring the base along.
    const base = service.createCollection(profileId, { name: 'Основа', version: '1.0.0', author: 'smoke', description: 'Оптимизация' });
    const addon = service.createCollection(profileId, {
      name: 'Аддон',
      version: '1.0.0',
      author: 'smoke',
      description: 'Поверх основы',
      requires: [{ collectionId: base.id, name: base.name, range: '^1.0.0' }],
    });
    const fresh = service.createProfile(game.id, 'Из коллекции', { gameVersion: '1.21.1', loader: 'fabric' });
    await service.switchProfile(game.id, fresh.id);
    const cplan = await service.planCollection(fresh.id, addon.id);
    log.push(`collection plan ok=${cplan.ok} chain=${cplan.collectionIds.length} install=${cplan.install.length} issues=${cplan.issues.map((i) => i.message).join(' | ')}`);
    await service.applyPlan(cplan.id);
    const after = service.state().profiles.find((p) => p.id === fresh.id)!;
    const creport = await service.compat(fresh.id);
    log.push(`collection applied: collections=${after.collections.length} mods=${Object.keys(after.mods).length} score=${creport.score}`);
    try {
      await service.removeCollectionFromProfile(fresh.id, base.id);
      log.push('collection guard: FAILED, base was removed under the addon');
    } catch (e) {
      log.push(`collection guard ok: ${(e as Error).message}`);
    }
    await service.switchProfile(game.id, profileId);
  } catch (e) {
    log.push(`seed failed: ${(e as Error).stack}`);
  }
  if (process.argv.includes('--archives')) {
    // Packaging check: the 7-Zip binary must live outside the asar and the RAR wasm must load.
    try {
      const dir = path.join(app.getPath('userData'), 'arc-src');
      await fs.mkdir(path.join(dir, 'Pack'), { recursive: true });
      await fs.writeFile(path.join(dir, 'Pack', 'a.esp'), 'plugin');
      const out = path.join(app.getPath('userData'), 'pack.7z');
      await new Promise<void>((res, rej) =>
        execFile(sevenZip(), ['a', '-t7z', out, '*'], { cwd: dir, windowsHide: true }, (e) => (e ? rej(e) : res())),
      );
      log.push(`archives: 7z at ${sevenZip()} lists ${(await listArchive(out)).join(', ')}`);
      const fake = path.join(app.getPath('userData'), 'fake.rar');
      await fs.writeFile(fake, 'not a rar');
      await listArchive(fake).then(
        () => log.push('archives: rar unexpectedly accepted garbage'),
        (e) => log.push(`archives: rar decoder loaded, rejects garbage (${String((e as Error).message).slice(0, 60)})`),
      );
    } catch (e) {
      log.push(`archives failed: ${(e as Error).stack}`);
    }
  }
  if (process.argv.includes('--thunderstore')) {
    trace('smoke: thunderstore');
    try {
      const dir = path.join(app.getPath('userData'), 'valheim');
      await fs.mkdir(dir, { recursive: true });
      const vh = await service.addGame('valheim', dir);
      const plan = await service.planInstall(vh.activeProfileId, [{ ref: { source: 'thunderstore', projectId: 'ValheimModding-Jotunn' }, title: 'Jotunn' }]);
      log.push(`valheim plan ok=${plan.ok} install=${plan.install.map((i) => `${i.title}@${i.version.version}`).join(', ')} issues=${plan.issues.map((i) => i.message).join(' | ')}`);
      await service.applyPlan(plan.id, true);
      const walk = async (d: string, rel = ''): Promise<string[]> =>
        (await fs.readdir(d, { withFileTypes: true })).flatMap((e) => (e.isDirectory() ? [] : [`${rel}${e.name}`])).concat(
          ...(await Promise.all((await fs.readdir(d, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => walk(path.join(d, e.name), `${rel}${e.name}/`)))),
        );
      const files = await walk(dir);
      log.push(`valheim deployed ${files.length} files: ${files.filter((f) => /winhttp|plugins\/.+\.dll$/i.test(f)).slice(0, 8).join(', ')}`);
      const report = await service.compat(vh.activeProfileId);
      log.push(`valheim compat score=${report.score} errors=${report.errors}`);
    } catch (e) {
      log.push(`thunderstore failed: ${(e as Error).stack}`);
    }
  }
  if (process.argv.includes('--light')) service.updateSettings({ theme: 'light' });
  send('state', service.state());
  const routes = (process.argv.find((a) => a.startsWith('--routes='))?.slice(9) ?? 'mods,discover,graph,collections,downloads,snapshots,settings').split(',');
  win.setSize(1400, 880);
  trace(`smoke: seeded, ${log.length} log lines`);
  for (const r of routes) {
    trace(`smoke: capture ${r}`);
    await win.webContents.executeJavaScript(`location.hash = '#/${r}'`);
    await wait(r === 'discover' ? 4000 : 1500);
    const img = await win.webContents.capturePage();
    await fs.writeFile(path.join(outDir, `${r}.png`), img.toPNG());
  }
  await fs.writeFile(path.join(outDir, 'log.txt'), log.join('\n'));
  await service.store.flush();
  app.exit(0);
}

// ---------- nxm:// links ("Mod Manager Download" on nexusmods.com)

const pendingNxm: string[] = [];
const nxmArg = (argv: string[]) => argv.find((a) => /^nxm:\/\//i.test(a));

function openNxm(url: string) {
  if (!service || !win) {
    pendingNxm.push(url);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.focus();
  service.handleNxm(url).catch((e) => send('toast', { kind: 'err', text: `Nexus: ${(e as Error).message}` }));
}

// One running instance: a second launch (from an nxm:// link) hands its link over.
if (!smoke && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, argv) => {
  const url = nxmArg(argv);
  if (url) openNxm(url);
  else win?.focus();
});
app.on('open-url', (e, url) => {
  e.preventDefault();
  openNxm(url);
});
const startNxm = nxmArg(process.argv);
if (startNxm) pendingNxm.push(startNxm);

/** Registers Lattice for nxm:// only while the user has it switched on. */
let nxmRegistered: boolean | null = null;
function syncNxmProtocol(on: boolean) {
  if (smoke || nxmRegistered === on) return;
  nxmRegistered = on;
  const args: [string, string?, string[]?] = process.defaultApp ? ['nxm', process.execPath, [path.resolve(process.argv[1] ?? '.')]] : ['nxm'];
  if (on) app.setAsDefaultProtocolClient(...args);
  else if (app.isDefaultProtocolClient(...args)) app.removeAsDefaultProtocolClient(...args);
}

/** Secrets at rest go through the OS keychain when it is available. */
const osSecrets = {
  encrypt: (s: string) => (safeStorage.isEncryptionAvailable() ? `os:${safeStorage.encryptString(s).toString('base64')}` : `b64:${Buffer.from(s).toString('base64')}`),
  decrypt: (s: string) =>
    s.startsWith('os:') ? safeStorage.decryptString(Buffer.from(s.slice(3), 'base64')) : Buffer.from(s.replace(/^b64:/, ''), 'base64').toString('utf8'),
};

app.whenReady().then(async () => {
  trace('ready');
  const userData = app.getPath('userData');
  service = new Service(path.join(userData, 'state.json'), path.join(userData, 'data'), osSecrets, (url) => {
    if (/^https:\/\/www\.nexusmods\.com\//.test(url)) return shell.openExternal(url);
  });
  service.on('state', (s) => {
    send('state', s);
    syncNxmProtocol(s.settings.handleNxm);
  });
  service.on('toast', (t) => send('toast', t));
  service.on('deployed', (d) => send('deployed', d));
  service.on('plan', (p) => send('plan', p));
  service.downloads.on('update', (list) => send('downloads', list));
  syncNxmProtocol(service.settings.handleNxm);
  registerIpc();
  if (smoke) {
    app.on('render-process-gone', (_e, _wc, d) => trace(`renderer gone: ${d.reason}`));
  }
  await createWindow().catch((e) => trace(`createWindow failed: ${(e as Error).message}`));
  trace('window loaded');
  for (const url of pendingNxm.splice(0)) openNxm(url);
  if (smoke) void runSmoke().catch((e) => trace(`smoke failed: ${(e as Error).stack}`));
});

app.on('window-all-closed', async () => {
  await service?.store.flush();
  app.quit();
});
