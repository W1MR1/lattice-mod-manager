// Dev loop: Vite dev server for the renderer, esbuild watch for main/preload, then Electron.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = `http://localhost:${server.config.server.port}`;

const pkg = JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const common = {
  define: {
    'process.env.LATTICE_VERSION': JSON.stringify(pkg.version),
    'process.env.LATTICE_NEXUS_SLUG': JSON.stringify(process.env.LATTICE_NEXUS_SLUG ?? ''),
    'process.env.LATTICE_CURSEFORGE_KEY': JSON.stringify(process.env.LATTICE_CURSEFORGE_KEY ?? ''),
  },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['electron', '7zip-bin', 'node-unrar-js', 'electron-updater'],
};
await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' });
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' });

const electronPath = require('electron');
const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, LATTICE_DEV_URL: url },
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
