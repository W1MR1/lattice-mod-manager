// Supported games and auto-detection of their install folders.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { GameDef } from '../../shared/types';
import { tk } from '../../shared/i18n';
import catalog from './thunderstore-games.json';

export const GAME_DEFS: GameDef[] = [
  {
    id: 'minecraft',
    name: 'Minecraft: Java Edition',
    short: 'MC',
    hue: 142,
    kind: 'minecraft',
    sources: ['modrinth', 'curseforge', 'github', 'local'],
    deployDir: '',
    loaders: ['fabric', 'quilt', 'neoforge', 'forge'],
    defaultPath: path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft'),
    notes: tk('Укажите папку .minecraft или папку экземпляра лаунчера. Моды попадают в mods/, ресурспаки — в resourcepacks/, шейдеры — в shaderpacks/.'),
    github: { keywords: 'minecraft' },
  },
  {
    id: 'lethal-company',
    gamebananaId: 19344,
    exe: ['Lethal Company.exe'],
    name: 'Lethal Company',
    short: 'LC',
    hue: 8,
    kind: 'bepinex',
    sources: ['thunderstore', 'nexus', 'curseforge', 'gamebanana', 'github', 'local'],
    thunderstoreCommunity: 'lethal-company',
    steamAppId: '1966720',
    deployDir: '',
    nexusDomain: 'lethalcompany',
    github: { keywords: '"lethal company"' },
  },
  {
    id: 'valheim',
    gamebananaId: 6506,
    exe: ['valheim.exe'],
    name: 'Valheim',
    short: 'VH',
    hue: 32,
    kind: 'bepinex',
    sources: ['thunderstore', 'nexus', 'curseforge', 'gamebanana', 'github', 'local'],
    thunderstoreCommunity: 'valheim',
    steamAppId: '892970',
    deployDir: '',
    nexusDomain: 'valheim',
    github: { keywords: 'valheim' },
  },
  {
    id: 'riskofrain2',
    gamebananaId: 12710,
    exe: ['Risk of Rain 2.exe'],
    name: 'Risk of Rain 2',
    short: 'R2',
    hue: 268,
    kind: 'bepinex',
    sources: ['thunderstore', 'curseforge', 'gamebanana', 'github', 'local'],
    thunderstoreCommunity: 'riskofrain2',
    steamAppId: '632360',
    deployDir: '',
    github: { keywords: '"risk of rain 2"' },
  },
  {
    id: 'content-warning',
    gamebananaId: 20089,
    exe: ['Content Warning.exe'],
    name: 'Content Warning',
    short: 'CW',
    hue: 52,
    kind: 'bepinex',
    sources: ['thunderstore', 'curseforge', 'gamebanana', 'github', 'local'],
    thunderstoreCommunity: 'content-warning',
    steamAppId: '2881650',
    deployDir: '',
    github: { keywords: '"content warning"' },
  },
  {
    id: 'skyrimse',
    gamebananaId: 25134,
    exe: ['SkyrimSE.exe'],
    name: 'Skyrim Special Edition',
    short: 'SK',
    hue: 210,
    kind: 'generic',
    sources: ['nexus', 'curseforge', 'gamebanana', 'github', 'local'],
    steamAppId: '489830',
    deployDir: 'Data',
    stripSingleRoot: true,
    notes: tk('Архивы распаковываются в Data/, установщики FOMOD проходят мастером. plugins.txt ведётся по порядку модов.'),
    nexusDomain: 'skyrimspecialedition',
    pluginsTxt: { folder: 'Skyrim Special Edition', baseMasters: ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm', '_ResourcePack.esl'] },
    github: { keywords: 'skyrim' },
  },
  {
    id: 'fallout4',
    gamebananaId: 5518,
    exe: ['Fallout4.exe'],
    name: 'Fallout 4',
    short: 'F4',
    hue: 96,
    kind: 'generic',
    sources: ['nexus', 'curseforge', 'gamebanana', 'github', 'local'],
    steamAppId: '377160',
    deployDir: 'Data',
    stripSingleRoot: true,
    nexusDomain: 'fallout4',
    pluginsTxt: {
      folder: 'Fallout4',
      baseMasters: ['Fallout4.esm', 'DLCRobot.esm', 'DLCworkshop01.esm', 'DLCCoast.esm', 'DLCworkshop02.esm', 'DLCworkshop03.esm', 'DLCNukaWorld.esm', 'DLCUltraHighResolution.esm'],
    },
    github: { keywords: '"fallout 4"' },
  },
  {
    id: 'cyberpunk2077',
    gamebananaId: 8722,
    exe: ['bin/x64/Cyberpunk2077.exe'],
    name: 'Cyberpunk 2077',
    short: 'CP',
    hue: 58,
    kind: 'generic',
    sources: ['nexus', 'curseforge', 'gamebanana', 'github', 'local'],
    steamAppId: '1091500',
    deployDir: '',
    notes: tk('Архивы распаковываются в корень игры (archive/, bin/, r6/, red4ext/).'),
    nexusDomain: 'cyberpunk2077',
    github: {
      keywords: 'cyberpunk',
      // the frameworks most Cyberpunk mods are built on, all released on GitHub
      featured: [
        { repo: 'wopss/RED4ext' },
        { repo: 'yamashi/CyberEngineTweaks' },
        { repo: 'jac3km4/redscript' },
        { repo: 'psiberx/cp2077-archive-xl', requires: ['wopss/RED4ext'] },
        { repo: 'psiberx/cp2077-tweak-xl', requires: ['wopss/RED4ext'] },
        { repo: 'psiberx/cp2077-codeware', requires: ['wopss/RED4ext'] },
      ],
    },
  },
  {
    id: 'stardewvalley',
    gamebananaId: 5937,
    exe: ['Stardew Valley.exe', 'StardewValley.exe'],
    name: 'Stardew Valley',
    short: 'SV',
    hue: 120,
    kind: 'generic',
    sources: ['nexus', 'curseforge', 'gamebanana', 'github', 'local'],
    steamAppId: '413150',
    deployDir: 'Mods',
    nexusDomain: 'stardewvalley',
    github: { keywords: 'stardew' },
  },
];

// Every other BepInEx game Thunderstore lists, with the facts r2modman itself
// works from (scripts/thunderstore-games.mjs). A game written by hand above wins.
{
  const known = new Set(GAME_DEFS.flatMap((d) => [d.id, d.thunderstoreCommunity ?? '']));
  const added = new Set<string>();
  const hueOf = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const shortOf = (name: string) => {
    const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return ((words.length > 1 ? words[0][0] + words[1][0] : name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2)) || '?').toUpperCase();
  };
  for (const g of catalog.games as { id: string; name: string; community: string; steam: string; folder: string; exe: string[]; also?: string[] }[]) {
    if (known.has(g.id) || known.has(g.community) || added.has(g.id)) continue;
    added.add(g.id);
    GAME_DEFS.push({
      id: g.id,
      name: g.name,
      short: shortOf(g.name),
      hue: hueOf(g.id),
      kind: 'bepinex',
      sources: ['thunderstore', 'local'],
      thunderstoreCommunity: g.community,
      steamAppId: g.steam,
      steamFolder: g.folder,
      deployDir: '',
      exe: g.exe,
      aliases: g.also,
      catalog: true,
    });
  }
}

/** Thunderstore packages that are the BepInEx loader itself (lower-case ids "owner-name"). */
export const BEPINEX_PACKS = new Set<string>(catalog.packs);
/**
 * Packages every Thunderstore community lists that are not mods: other mod
 * managers and broken uploads. r2modman hides the same ones; installed as a
 * mod, a manager's own program would land among the game's plugins.
 */
const NOT_MODS = new Set<string>(catalog.notMods);
export const isThunderstoreMod = (projectId: string) => !NOT_MODS.has(projectId.toLowerCase());
/** Is this Thunderstore package the mod loader rather than a mod? */
export const isBepInExPack = (projectId: string) => /bepinexpack/i.test(projectId) || BEPINEX_PACKS.has(projectId.toLowerCase());

export const gameDef = (id: string) => GAME_DEFS.find((g) => g.id === id);

function regQuery(key: string, value: string): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', value], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`).exec(stdout);
      resolve(m ? m[1].trim() : null);
    });
  });
}

/** Minimal VDF reader: returns every `"path"` value (library roots). */
function libraryPaths(vdf: string): string[] {
  return [...vdf.matchAll(/"path"\s+"([^"]+)"/g)].map((m) => m[1].replace(/\\\\/g, '\\'));
}

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function steamLibraries(): Promise<string[]> {
  const roots = new Set<string>();
  const reg = (await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath')) ?? (await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'));
  const candidates = [reg, 'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam', path.join(os.homedir(), '.steam', 'steam')].filter(Boolean) as string[];
  for (const c of candidates) {
    const root = path.normalize(c);
    if (!(await exists(path.join(root, 'steamapps')))) continue;
    roots.add(root);
    try {
      const vdf = await fs.readFile(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const p of libraryPaths(vdf)) roots.add(path.normalize(p));
    } catch {
      /* single library */
    }
  }
  return [...roots];
}
