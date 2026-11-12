// Rebuilds electron/core/thunderstore-games.json from Thunderstore's own
// ecosystem schema — the list r2modman and the Thunderstore app are built from.
//
// Only games Lattice can install exactly as r2modman does are taken:
// BepInEx, the default install rules, a Windows executable, a Steam copy to
// find the game by. Everything else is left out rather than guessed.
//
//   npm run games
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = 'https://thunderstore.io/api/experimental/schema/dev/latest/';
// packages listed in every community that are not mods: mod managers, broken uploads (r2modman hides the same ones)
const EXCLUSIONS = 'https://raw.githubusercontent.com/ebkr/r2modmanPlus/develop/modExclusions.md';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'core', 'thunderstore-games.json');

/** What r2modman does with a BepInEx package when a game sets no rules of its own. */
const DEFAULT_RULES = {
  'BepInEx/plugins': 'subdir',
  'BepInEx/core': 'subdir',
  'BepInEx/patchers': 'subdir',
  'BepInEx/monomod': 'subdir',
  'BepInEx/config': 'none',
};

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const res = await fetch(SCHEMA, { headers: { 'User-Agent': 'lattice-mod-manager' } });
if (!res.ok) throw new Error(`${SCHEMA}: HTTP ${res.status}`);
const schema = await res.json();

const games = [];
const skipped = {};
const skip = (why) => (skipped[why] = (skipped[why] ?? 0) + 1);
const taken = new Set();
for (const [label, g] of Object.entries(schema.games)) {
  for (const e of g.r2modman ?? []) {
    if (e.packageLoader !== 'bepinex') { skip('another mod loader'); continue; }
    if (e.gameInstanceType !== 'game' || e.gameSelectionDisplayMode !== 'visible') { skip('a server or a hidden entry'); continue; }
    const rules = Object.fromEntries((e.installRules ?? []).map((r) => [r.route, r.trackingMethod]));
    const same = JSON.stringify(Object.entries(rules).sort()) === JSON.stringify(Object.entries(DEFAULT_RULES).sort());
    if (!same || (e.installRules ?? []).some((r) => r.subRoutes?.length)) { skip('install rules of its own'); continue; }
    const steam = (e.distributions ?? []).find((d) => d.platform === 'steam' && d.identifier)?.identifier;
    const exe = (e.exeNames ?? []).filter((x) => /\.exe$/i.test(x));
    const community = /\/c\/([^/]+)\//.exec(e.packageIndex ?? '')?.[1];
    if (!steam || !exe.length || !e.steamFolderName || !community) { skip('no Steam copy or no Windows executable'); continue; }
    const name = e.meta?.displayName ?? g.meta?.displayName ?? label;
    let id = taken.has(label) ? slug(name) : label;
    if (taken.has(id)) { skip('a second entry of the same game'); continue; }
    taken.add(id);
    const also = (e.additionalSearchStrings ?? []).filter((s) => s && s.toLowerCase() !== name.toLowerCase());
    games.push({ id, name, community, steam: String(steam), folder: e.steamFolderName, exe, ...(also.length ? { also } : {}) });
  }
}
games.sort((a, b) => a.name.localeCompare(b.name, 'en'));

const ex = await fetch(EXCLUSIONS, { headers: { 'User-Agent': 'lattice-mod-manager' } });
if (!ex.ok) throw new Error(`${EXCLUSIONS}: HTTP ${ex.status}`);
const notMods = [...new Set((await ex.text()).split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => /^[a-z0-9_]+-[a-z0-9_]+$/.test(l)))].sort();
if (notMods.length < 10) throw new Error('the exclusion list looks wrong');

const packs = [...new Set(schema.modloaderPackages.filter((m) => m.loader === 'bepinex').map((m) => m.packageId.toLowerCase()))].sort();

const lines = [
  '{',
  `  "source": ${JSON.stringify(SCHEMA)},`,
  `  "fetched": ${JSON.stringify(new Date().toISOString().slice(0, 10))},`,
  `  "packs": ${JSON.stringify(packs)},`,
  `  "notMods": ${JSON.stringify(notMods)},`,
  '  "games": [',
  games.map((g) => `    ${JSON.stringify(g)}`).join(',\n'),
  '  ]',
  '}',
  '',
];
await fs.writeFile(OUT, lines.join('\n'));
console.log(`${games.length} games, ${packs.length} BepInEx packs, ${notMods.length} packages that are not mods → ${path.relative(process.cwd(), OUT)}`);
for (const [why, n] of Object.entries(skipped)) console.log(`  left out, ${why}: ${n}`);
