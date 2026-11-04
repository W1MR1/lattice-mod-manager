// Supported games and auto-detection of their install folders.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { DetectedGame, GameDef } from '../../shared/types';
import { tk } from '../../shared/i18n';

export const GAME_DEFS: GameDef[] = [
  {
    id: 'minecraft',
    name: 'Minecraft: Java Edition',
    short: 'MC',
    hue: 142,
    kind: 'minecraft',
    sources: ['modrinth', 'github', 'local'],
    deployDir: '',
    loaders: ['fabric', 'quilt', 'neoforge', 'forge'],
    defaultPath: path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft'),
    notes: tk('Укажите папку .minecraft или папку экземпляра лаунчера. Моды попадают в mods/, ресурспаки — в resourcepacks/, шейдеры — в shaderpacks/.'),
    github: { keywords: 'minecraft' },
  },
  {
    id: 'lethal-company',
    name: 'Lethal Company',
    short: 'LC',
    hue: 8,
    kind: 'bepinex',
    sources: ['thunderstore', 'nexus', 'github', 'local'],
    thunderstoreCommunity: 'lethal-company',
    steamAppId: '1966720',
    deployDir: '',
    nexusDomain: 'lethalcompany',
    github: { keywords: '"lethal company"' },
  },
  {
    id: 'valheim',
    name: 'Valheim',
    short: 'VH',
    hue: 32,
    kind: 'bepinex',
    sources: ['thunderstore', 'nexus', 'github', 'local'],
    thunderstoreCommunity: 'valheim',
    steamAppId: '892970',
    deployDir: '',
    nexusDomain: 'valheim',
    github: { keywords: 'valheim' },
  },
  {
    id: 'riskofrain2',
    name: 'Risk of Rain 2',
    short: 'R2',
    hue: 268,
    kind: 'bepinex',
    sources: ['thunderstore', 'github', 'local'],
    thunderstoreCommunity: 'riskofrain2',
    steamAppId: '632360',
    deployDir: '',
    github: { keywords: '"risk of rain 2"' },
  },
  {
    id: 'content-warning',
    name: 'Content Warning',
    short: 'CW',
    hue: 52,
    kind: 'bepinex',
    sources: ['thunderstore', 'github', 'local'],
    thunderstoreCommunity: 'content-warning',
    steamAppId: '2881650',
    deployDir: '',
    github: { keywords: '"content warning"' },
  },
  {
    id: 'skyrimse',
    name: 'Skyrim Special Edition',
    short: 'SK',
    hue: 210,
    kind: 'generic',
    sources: ['nexus', 'github', 'local'],
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
    name: 'Fallout 4',
    short: 'F4',
    hue: 96,
    kind: 'generic',
    sources: ['nexus', 'github', 'local'],
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
    name: 'Cyberpunk 2077',
    short: 'CP',
    hue: 58,
    kind: 'generic',
    sources: ['nexus', 'github', 'local'],
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
    name: 'Stardew Valley',
    short: 'SV',
    hue: 120,
    kind: 'generic',
    sources: ['nexus', 'github', 'local'],
    steamAppId: '413150',
    deployDir: 'Mods',
    nexusDomain: 'stardewvalley',
    github: { keywords: 'stardew' },
  },
];

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

export async function detectGames(): Promise<DetectedGame[]> {
  const found: DetectedGame[] = [];
  const libs = await steamLibraries();
  for (const def of GAME_DEFS) {
    if (def.steamAppId) {
      for (const lib of libs) {
        const acf = path.join(lib, 'steamapps', `appmanifest_${def.steamAppId}.acf`);
        try {
          const text = await fs.readFile(acf, 'utf8');
          const dir = /"installdir"\s+"([^"]+)"/.exec(text)?.[1];
          if (!dir) continue;
          const full = path.join(lib, 'steamapps', 'common', dir);
          if (await exists(full)) {
            found.push({ defId: def.id, path: full, via: 'steam' });
            break;
          }
        } catch {
          /* not in this library */
        }
      }
    }
    if (def.defaultPath && (await exists(def.defaultPath))) found.push({ defId: def.id, path: def.defaultPath, via: 'default' });
  }
  return found;
}
