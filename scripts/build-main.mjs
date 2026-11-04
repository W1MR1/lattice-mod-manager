// Bundles the Electron main and preload scripts into dist-electron/.
import { build, context } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  // native binaries and wasm are loaded relative to their own package folder
  external: ['electron', '7zip-bin', 'node-unrar-js', 'electron-updater'],
  logLevel: 'info',
  // release facts: the version Nexus sees, and the Nexus app slug once registered
  define: {
    'process.env.LATTICE_VERSION': JSON.stringify(pkg.version),
    'process.env.LATTICE_NEXUS_SLUG': JSON.stringify(process.env.LATTICE_NEXUS_SLUG ?? ''),
    'process.env.LATTICE_CURSEFORGE_KEY': JSON.stringify(process.env.LATTICE_CURSEFORGE_KEY ?? ''),
  },
};

const entries = [
  { entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' },
  { entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' },
];

if (watch) {
  for (const e of entries) {
    const ctx = await context({ ...common, ...e });
    await ctx.watch();
  }
} else {
  await Promise.all(entries.map((e) => build({ ...common, ...e })));
}
