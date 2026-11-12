// Where the files of a mod archive belong in the game.
//
// Authors pack mods every way there is: relative to the game folder, inside a
// wrapper folder (or two), as loose files, or as several alternative variants
// side by side. A manager that unpacks all of that "as it is" puts files where
// the game never looks, and the mod silently does not work. This module reads
// the list of archive entries and decides, per game, where each file goes — or
// says that a person has to choose (variants, or nothing recognisable).
//
// Everything here is pure: names in, a plan out. No file is touched.
import type { GameDef, LayoutChoice, LayoutOption } from '../../shared/types';
import { t } from '../../shared/i18n';

export type { LayoutChoice, LayoutOption } from '../../shared/types';

/** Staged files under this folder go to the game folder itself, not to the game's mod folder. */
export const GAME_ROOT = '__game_root__';

/** In a choice: the files lying loose at the top of the archive (not in any folder). */
export const TOP_FILES = './';

export interface LayoutDest {
  id: string;
  label: string;
}

export interface LayoutPlan {
  /** archive entry -> path under the deploy root; entries left out are not installed */
  map: Map<string, string>;
  /** `as-is`: packed the way the game reads it; `arranged`: Lattice moved things into place */
  how: 'as-is' | 'arranged' | 'unknown';
  /** what was done, in the user's language */
  notes: string[];
  /** the archive needs a human: several variants, or nothing Lattice recognises */
  ask?: { reason: 'variants' | 'unknown'; options: LayoutOption[]; dests: LayoutDest[] };
  /** other variants found inside an archive that installs by itself (optional folders) */
  extras: LayoutOption[];
  /** installed where they were, though nothing says the game reads them there */
  unplaced: string[];
}

// ---------- what each game reads

interface Model {
  /** first-level folders of the game folder that the game or its loaders read (lower case) */
  gameDirs: string[];
  /** a path (lower case, relative to a folder) that shows the folder is the game folder */
  gameSign: RegExp;
  /** loose files that belong in the game folder itself */
  gameFiles?: RegExp;
  /** the mod folder inside the game folder, when mods do not go to the game folder (lower case) */
  dataDir?: string;
  /** folders inside the mod folder (lower case) */
  dataDirs?: string[];
  /** loose files inside the mod folder */
  dataFiles?: RegExp;
  /** a folder that holds this file is a mod of its own and never the game folder */
  ownMod?: RegExp;
  /** a folder name that stands for the game folder inside a mod (Mod Organizer's "Root") */
  rootAlias?: string;
  /** a place for a file that sits outside all of the above; `rel` is relative to the content root */
  place?(rel: string, ctx: PlaceCtx): string | null;
  dests: () => LayoutDest[];
}

interface PlaceCtx {
  mod: string;
  /** every file of the content root, relative to it */
  all: string[];
}

const BETHESDA_DATA = [
  'meshes', 'textures', 'scripts', 'interface', 'sound', 'music', 'strings', 'seq', 'materials', 'video', 'shadersfx', 'lodsettings', 'grass', 'skse', 'f4se', 'mcm',
  'calientetools', 'nemesis_engine', 'netscriptframework', 'dialogueviews', 'source', 'facegen', 'vis', 'distantlod', 'trees', 'terrain', 'menus', 'fonts',
  'shaders', 'tools', 'platform', 'dyndolod', 'lightplacer', 'particlelights', 'pbrtexturesets', 'pbrnifpatcher', 'animations', 'edit scripts',
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** The nearest folder at or above the file `rel` that directly holds a file matching `marker`; null when none does. */
function dirWith(rel: string, all: string[], marker: RegExp): string | null {
  const parts = rel.split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    const dir = parts.slice(0, i).join('/');
    const prefix = dir ? `${dir}/` : '';
    if (all.some((n) => n.startsWith(prefix) && !n.slice(prefix.length).includes('/') && marker.test(n.slice(prefix.length)))) return dir;
  }
  return null;
}

const MODELS: Record<string, Model> = {
  cyberpunk2077: {
    gameDirs: ['archive', 'bin', 'r6', 'red4ext', 'engine', 'mods', 'tools'],
    gameSign: /^(archive\/pc\/|bin\/x64\/|r6\/(scripts|tweaks|input|config|cache|storages)\/|red4ext\/|engine\/(config|tools)\/|mods\/[^/]+\/(info\.json$|archives\/|scripts\/|tweaks\/|customsounds\/)|tools\/redmod\/)/,
    ownMod: /^init\.lua$/i,
    place(rel, { mod, all }) {
      // a REDmod folder: info.json beside archives/, scripts/, tweaks/ or customSounds/
      const red = dirWith(rel, all, /^info\.json$/i);
      if (red !== null && all.some((n) => new RegExp(`^${esc(red ? `${red}/` : '')}(archives|scripts|tweaks|customSounds)/`, 'i').test(n))) {
        return `mods/${red ? base(red) : mod}/${rel.slice(red ? red.length + 1 : 0)}`;
      }
      if (/\.(archive|xl)$/i.test(rel)) return `archive/pc/mod/${base(rel)}`;
      // a Cyber Engine Tweaks mod: a folder with init.lua
      const cet = dirWith(rel, all, /^init\.lua$/i);
      if (cet !== null) return `bin/x64/plugins/cyber_engine_tweaks/mods/${cet ? base(cet) : mod}/${rel.slice(cet ? cet.length + 1 : 0)}`;
      // scripts keep the folders they came in; lying loose they get a folder named after the mod
      if (/\.reds$/i.test(rel)) return `r6/scripts/${rel.includes('/') ? rel : `${mod}/${rel}`}`;
      if (/\.(ya?ml|tweak)$/i.test(rel)) return `r6/tweaks/${rel.includes('/') ? rel : `${mod}/${rel}`}`;
      if (/\.asi$/i.test(rel)) return `bin/x64/plugins/${base(rel)}`;
      return null;
    },
    dests: () => [
      { id: '', label: t('Папка игры (как в архиве)') },
      { id: 'archive/pc/mod', label: t('archive/pc/mod — файлы .archive') },
      { id: 'bin/x64/plugins/cyber_engine_tweaks/mods/{mod}', label: t('Мод Cyber Engine Tweaks (init.lua)') },
      { id: 'r6/scripts/{mod}', label: t('r6/scripts — скрипты redscript (.reds)') },
      { id: 'r6/tweaks/{mod}', label: t('r6/tweaks — твики TweakXL (.yaml)') },
      { id: 'red4ext/plugins/{mod}', label: t('red4ext/plugins — плагин RED4ext (.dll)') },
      { id: 'mods/{mod}', label: t('mods — мод формата REDmod') },
    ],
  },
  skyrimse: {
    gameDirs: ['enbseries', 'enbcache', 'reshade-shaders'],
    gameSign: /^(data\/|enbseries\/|reshade-shaders\/)/,
    gameFiles: /^(skse64_.*\.(exe|dll)|d3d11\.dll|d3dcompiler_46e\.dll|dxgi\.dll|dinput8\.dll|enb(series|local)\.ini|reshade\.ini|binkw64\.dll|tbb(malloc)?\.dll|xinput1_3\.dll|winhttp\.dll|version\.dll)$/i,
    dataDir: 'data',
    dataDirs: BETHESDA_DATA,
    dataFiles: /\.(esp|esm|esl|bsa|bsl|modgroups|ini)$/i,
    rootAlias: 'root',
    dests: () => [
      { id: '', label: t('Data — обычный мод') },
      { id: GAME_ROOT, label: t('Папка игры (SKSE, ENB и подобное)') },
    ],
  },
  fallout4: {
    gameDirs: ['enbseries', 'enbcache', 'reshade-shaders'],
    gameSign: /^(data\/|enbseries\/|reshade-shaders\/)/,
    gameFiles: /^(f4se_.*\.(exe|dll)|d3d11\.dll|d3dcompiler_46e\.dll|dxgi\.dll|dinput8\.dll|enb(series|local)\.ini|reshade\.ini|xinput1_3\.dll|winhttp\.dll|version\.dll|x-cell.*\.dll)$/i,
    dataDir: 'data',
    dataDirs: BETHESDA_DATA,
    dataFiles: /\.(esp|esm|esl|ba2|bsa|modgroups|ini)$/i,
    rootAlias: 'root',
    dests: () => [
      { id: '', label: t('Data — обычный мод') },
      { id: GAME_ROOT, label: t('Папка игры (F4SE, ENB и подобное)') },
    ],
  },
};

// ---------- helpers

const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$|\.git\/|\.gitignore$|\.gitattributes$)/i;
/** Papers and pictures that come with a mod: left out when they lie beside the content, not inside it. */
const PAPER = /^(read[ _-]?me|license|licence|changelog|change[ _-]?log|changes|credits|install(ation)?|how[ _-]to[ _-]install|permissions?|notes|description|preview|screenshot|thumbnail|banner|logo|icon)[^/]*\.(txt|md|pdf|rtf|docx?|html?|nfo|png|jpe?g|gif|webp|bmp|url)$/i;
const DOC_EXT = /\.(txt|md|pdf|rtf|docx?|html?|nfo|url)$/i;
const PIC_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const isPaper = (file: string) => PAPER.test(file) || DOC_EXT.test(file) || PIC_EXT.test(file);
/** Folders of an archive that are about the mod, not part of it. */
const SIDE_DIR = /^(fomod|docs?|documentation|screenshots?|images?|previews?|source|src)$/i;

/** Clean archive names: forward slashes, no junk, no folders. */
export function cleanNames(names: string[]): string[] {
  return names.map((n) => n.replace(/\\/g, '/').replace(/^\.\//, '')).filter((n) => n && !n.endsWith('/') && !JUNK.test(n));
}

function firstSeg(rel: string): { seg: string; isFile: boolean } {
  const i = rel.indexOf('/');
  return i < 0 ? { seg: rel, isFile: true } : { seg: rel.slice(0, i), isFile: false };
}

/** Whether an archive entry belongs to a chosen root, and its path inside it. */
const under = (n: string, root: string) => (root === TOP_FILES ? !n.includes('/') : n.startsWith(root));
const relTo = (n: string, root: string) => (root === TOP_FILES ? n : n.slice(root.length));

/** Every folder prefix of the archive ('' included), shallowest first. */
function prefixes(names: string[]): string[] {
  const set = new Set<string>(['']);
  for (const n of names) {
    const parts = n.split('/');
    for (let i = 1; i < parts.length; i++) set.add(`${parts.slice(0, i).join('/')}/`);
  }
  return [...set].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

type Level = 'game' | 'data' | null;

/** Does this folder look like the game folder, or like the game's mod folder? */
function levelOf(model: Model, prefix: string, names: string[]): Level {
  let data = false;
  let game = false;
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    const rel = n.slice(prefix.length);
    const { seg, isFile } = firstSeg(rel);
    if (isFile) {
      if (model.ownMod?.test(seg)) return null;
      if (model.gameFiles?.test(seg)) game = true;
      else if (model.dataFiles?.test(seg)) data = true;
    } else if (model.gameSign.test(rel.toLowerCase())) game = true;
    else if (model.dataDirs?.includes(seg.toLowerCase())) data = true;
  }
  return game ? 'game' : data ? 'data' : null;
}

function isRead(model: Model, rel: string): boolean {
  const low = firstSeg(rel).seg.toLowerCase();
  return model.gameDirs.includes(low) || low === model.dataDir || low === model.rootAlias || !!model.dataDirs?.includes(low);
}

function optionOf(path: string, names: string[], suggested: boolean): LayoutOption {
  const inside = names.filter((n) => under(n, path));
  return { path, files: inside.length, sample: inside.slice(0, 4).map((n) => relTo(n, path)), suggested };
}

/** The top folders of an archive (and its loose top files) as options. */
function topOptions(names: string[]): LayoutOption[] {
  const tops = [...new Set(names.map((n) => (n.includes('/') ? `${n.slice(0, n.indexOf('/'))}/` : TOP_FILES)))];
  return tops.map((p) => optionOf(p, names, true));
}

/** Folder names that read as "the main part" or as "an extra". */
const MAINISH = /(^|[\s_\-./\\([])(main|core|base|required|default|standard|vanilla)([\s_\-.)\]/\\]|$)/i;
const EXTRAISH = /(optional|option|patch|compat|addon|add-on|alternative|variant|legacy|old|extra|bonus|misc|source|src|backup)/i;

function suggest(roots: string[]): Set<string> {
  const mainish = roots.filter((r) => MAINISH.test(base(r.replace(/\/$/, ''))) && !EXTRAISH.test(r));
  if (mainish.length) return new Set(mainish);
  const plain = roots.filter((r) => !EXTRAISH.test(r));
  return new Set([(plain.length ? plain : roots)[0]]);
}

/** The mod's name as a folder name. */
export function modFolderName(name: string): string {
  const stem = name
    .replace(/\.(zip|7z|rar|jar)$/i, '')
    // Nexus archive names end with -<mod id>-<version>-<upload time>
    .replace(/-\d+(-[\w]+)*-\d{9,11}$/, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stem.slice(0, 60) || 'mod';
}

function emptyPlan(): LayoutPlan {
  return { map: new Map(), how: 'as-is', notes: [], extras: [], unplaced: [] };
}

/** Puts the chosen roots where the user said, without working anything out. */
function manualPlan(names: string[], mod: string, choice: LayoutChoice, dests: LayoutDest[]): LayoutPlan {
  const plan = emptyPlan();
  const dest = choice.dest!.replace(/\{mod\}/g, mod).replace(/\/+$/, '');
  for (const root of choice.roots.length ? choice.roots : ['']) {
    for (const n of names) {
      if (!under(n, root)) continue;
      const rel = relTo(n, root);
      const { seg, isFile } = firstSeg(rel);
      if (isFile ? PAPER.test(seg) || DOC_EXT.test(seg) : SIDE_DIR.test(seg)) continue;
      plan.map.set(n, dest ? `${dest}/${rel}` : rel);
    }
  }
  plan.how = 'arranged';
  plan.notes.push(t('Файлы положены туда, куда вы указали: {0}', dests.find((d) => d.id === choice.dest)?.label ?? dest));
  return plan;
}

const manual = (c?: LayoutChoice): c is LayoutChoice & { dest: string } => c?.dest !== undefined;

// ---------- games with a model: Cyberpunk 2077, Skyrim SE, Fallout 4

/** Lays out one content root into `plan`; tells whether anything had to be moved. */
function layRoot(model: Model, def: GameDef, root: string, level: Level, names: string[], mod: string, plan: LayoutPlan, skip: string[]): boolean {
  const inside = names.filter((n) => under(n, root) && !skip.some((s) => n.startsWith(s))).map((n) => relTo(n, root));
  const deployIsData = !!model.dataDir && def.deployDir.toLowerCase() === model.dataDir;
  let arranged = root !== '' && root !== TOP_FILES;
  const put = (rel: string, target: string) => {
    plan.map.set(root === TOP_FILES ? rel : root + rel, target);
    if (target !== rel) arranged = true;
  };
  for (const rel of inside) {
    const { seg, isFile } = firstSeg(rel);
    const low = seg.toLowerCase();
    if (level === 'game') {
      if (!isFile && low === model.dataDir) {
        // Data/… is the deploy root itself when the game deploys into Data
        put(rel, deployIsData ? rel.slice(seg.length + 1) : rel);
        continue;
      }
      if ((!isFile && model.gameDirs.includes(low)) || (isFile && model.gameFiles?.test(seg))) {
        put(rel, deployIsData ? `${GAME_ROOT}/${rel}` : rel);
        continue;
      }
    }
    // loose mod files and folders, also when they lie beside Data/
    if (level && ((isFile && model.dataFiles?.test(seg)) || (!isFile && model.dataDirs?.includes(low)))) {
      put(rel, rel);
      continue;
    }
    if (!isFile && model.rootAlias && low === model.rootAlias) {
      // Root/… inside a mod is the game folder (the Root Builder habit of Mod Organizer)
      put(rel, `${GAME_ROOT}/${rel.slice(seg.length + 1)}`);
      continue;
    }
    if (isFile ? isPaper(seg) : SIDE_DIR.test(seg)) continue; // papers beside the content
    if (PAPER.test(base(rel))) continue; // a readme goes into no folder of the game
    const placed = model.place?.(rel, { mod, all: inside });
    if (placed) {
      put(rel, placed);
      continue;
    }
    if (isPaper(base(rel))) continue; // papers inside a folder the game does not read
    // known neither by place nor by name: stays where it was, and is told about
    put(rel, rel);
    plan.unplaced.push(rel);
  }
  return arranged;
}

function modelPlan(model: Model, def: GameDef, names: string[], mod: string, choice?: LayoutChoice): LayoutPlan {
  const dests = model.dests();
  if (manual(choice)) return manualPlan(names, mod, choice, dests);
  const plan = emptyPlan();
  const all = prefixes(names);
  const levels = new Map<string, Level>(all.map((p) => [p, levelOf(model, p, names)]));
  // content roots: recognised folders with no recognised folder above them
  const roots = all.filter((p) => levels.get(p) && !all.some((a) => a !== p && p.startsWith(a) && levels.get(a)));
  // variants kept inside a root, under a folder the game does not read ("Optional/Darker/textures/…")
  const nested = (root: string) => {
    const cands = all.filter((p) => p !== root && p.startsWith(root) && levels.get(p) && !isRead(model, p.slice(root.length)));
    return cands.filter((p) => !cands.some((a) => a !== p && p.startsWith(a)));
  };

  const chosen = choice?.roots.filter((r) => r === '' || r === TOP_FILES || all.includes(r));
  const use = chosen?.length ? chosen : roots.length === 1 ? roots : null;

  if (!use) {
    if (roots.length > 1) {
      const pick = suggest(roots);
      plan.ask = { reason: 'variants', options: roots.map((r) => optionOf(r, names, pick.has(r))), dests };
      // what installing without an answer takes: the part that reads as the main one
      for (const r of roots.filter((x) => pick.has(x))) layRoot(model, def, r, levels.get(r)!, names, mod, plan, []);
      plan.how = 'arranged';
      return plan;
    }
    // nothing recognised by folder: file by file
    const arranged = layRoot(model, def, '', null, names, mod, plan, []);
    const placed = [...plan.map.keys()].filter((k) => !plan.unplaced.includes(k)).length;
    if (placed === 0) {
      plan.ask = { reason: 'unknown', options: topOptions(names), dests };
      plan.how = 'unknown';
      return plan;
    }
    plan.how = arranged ? 'arranged' : 'as-is';
    if (arranged) plan.notes.push(t('Файлы разложены по папкам игры: {0}', describe(plan)));
    return plan;
  }

  let arranged = false;
  for (const root of use) {
    const inner = chosen?.length ? [] : nested(root);
    if (layRoot(model, def, root, levels.get(root) ?? null, names, mod, plan, inner)) arranged = true;
    plan.extras.push(...inner.map((p) => optionOf(p, names, false)));
    if (root && root !== TOP_FILES) plan.notes.push(t('Снята папка-обёртка «{0}»', root.replace(/\/$/, '')));
  }
  // variants the user left out stay available
  if (chosen?.length) plan.extras.push(...roots.filter((r) => !chosen.includes(r)).map((p) => optionOf(p, names, false)));
  if (arranged && plan.notes.length === 0) plan.notes.push(t('Файлы разложены по папкам игры: {0}', describe(plan)));
  plan.how = arranged ? 'arranged' : 'as-is';
  return plan;
}

/** The folders a plan writes to, for a note. */
function describe(plan: LayoutPlan): string {
  const tops = new Set<string>();
  for (const target of plan.map.values()) {
    const parts = target.split('/');
    const depth = parts[0] === 'bin' ? 5 : parts[0] === 'archive' ? 3 : 2;
    tops.add(parts.slice(0, Math.max(1, Math.min(parts.length - 1, depth))).join('/'));
  }
  return [...tops].slice(0, 4).join(', ');
}

// ---------- Stardew Valley: every mod is a folder with manifest.json

const STARDEW_DESTS = (): LayoutDest[] => [
  { id: '{mod}', label: t('Mods/<имя мода> — мод SMAPI') },
  { id: '', label: t('Mods (как в архиве)') },
  { id: GAME_ROOT, label: t('Папка игры') },
];

function stardewPlan(names: string[], mod: string, choice?: LayoutChoice): LayoutPlan {
  const dests = STARDEW_DESTS();
  if (manual(choice)) return manualPlan(names, mod, choice, dests);
  const plan = emptyPlan();
  const scope = choice?.roots.length ? names.filter((n) => choice.roots.some((r) => under(n, r))) : names;
  const dirs = scope.filter((n) => /(^|\/)manifest\.json$/i.test(n)).map((n) => n.slice(0, n.length - 'manifest.json'.length));
  // a manifest inside another mod's folder belongs to that mod
  const mods = dirs.filter((d) => !dirs.some((o) => o !== d && d.startsWith(o)));
  if (mods.length === 0) {
    // replacements of the game's own Content files (old XNB mods)
    const content = prefixes(scope).find((p) => scope.some((n) => n.toLowerCase().startsWith(`${p.toLowerCase()}content/`)));
    if (content !== undefined) {
      for (const n of scope) if (n.toLowerCase().startsWith(`${content.toLowerCase()}content/`)) plan.map.set(n, `${GAME_ROOT}/Content/${n.slice(content.length + 'content/'.length)}`);
      plan.how = 'arranged';
      plan.notes.push(t('Замена файлов Content игры: кладётся в папку игры'));
      return plan;
    }
    plan.ask = { reason: 'unknown', options: topOptions(scope), dests };
    plan.how = 'unknown';
    for (const n of scope) plan.map.set(n, n);
    return plan;
  }
  const used = new Set<string>();
  for (const d of mods) {
    let folder = d ? base(d.replace(/\/$/, '')) : mod;
    // two mods of one archive with the same folder name stay apart
    while (used.has(folder.toLowerCase())) folder = `${folder}_`;
    used.add(folder.toLowerCase());
    for (const n of scope) if (n.startsWith(d)) plan.map.set(n, `${folder}/${n.slice(d.length)}`);
  }
  const moved = mods.some((d) => d === '' || d.split('/').length > 2);
  plan.how = moved ? 'arranged' : 'as-is';
  if (moved) plan.notes.push(mods.length > 1 ? t('Каждый мод SMAPI положен в свою папку в Mods ({0})', mods.length) : t('Мод SMAPI положен в свою папку в Mods'));
  return plan;
}

// ---------- BepInEx games: archives from Nexus, GitHub and GameBanana (Thunderstore packages have their own rules)

const BEPINEX_DESTS = (): LayoutDest[] => [
  { id: 'BepInEx/plugins/{mod}', label: t('BepInEx/plugins — плагин') },
  { id: 'BepInEx/patchers/{mod}', label: t('BepInEx/patchers — патчер') },
  { id: 'BepInEx/config', label: t('BepInEx/config — настройки') },
  { id: '', label: t('Папка игры (как в архиве)') },
];

const BEPINEX_KINDS = new Set(['plugins', 'patchers', 'config', 'core', 'monomod']);

function bepinexPlan(names: string[], mod: string, choice?: LayoutChoice): LayoutPlan {
  if (manual(choice)) return manualPlan(names, mod, choice, BEPINEX_DESTS());
  const plan = emptyPlan();
  const scope = choice?.roots.length ? names.filter((n) => choice.roots.some((r) => under(n, r))) : names;
  // the loader itself: winhttp.dll beside BepInEx/
  const pack = scope.find((n) => /(^|\/)(winhttp\.dll|doorstop_config\.ini)$/i.test(n));
  if (pack) {
    const root = pack.slice(0, pack.lastIndexOf('/') + 1);
    for (const n of scope) if (n.startsWith(root)) plan.map.set(n, n.slice(root.length));
    plan.how = root ? 'arranged' : 'as-is';
    return plan;
  }
  const paper = (seg: string, isFile: boolean) => isFile && (isPaper(seg) || /^manifest\.json$/i.test(seg));
  // the folder that holds BepInEx/ is the game folder
  const game = prefixes(scope).find((p) => scope.some((n) => n.toLowerCase().startsWith(`${p.toLowerCase()}bepinex/`)));
  if (game !== undefined) {
    for (const n of scope) {
      if (!n.startsWith(game)) continue;
      const rel = n.slice(game.length);
      const { seg, isFile } = firstSeg(rel);
      if (paper(seg, isFile)) continue;
      plan.map.set(n, rel.replace(/^bepinex\//i, 'BepInEx/'));
    }
    plan.how = game ? 'arranged' : 'as-is';
    if (game) plan.notes.push(t('Снята папка-обёртка «{0}»', game.replace(/\/$/, '')));
    return plan;
  }
  // one wrapper folder comes off; then plugins/, patchers/, config/ go to their places and
  // everything else into the mod's own plugin folder
  const tops = new Set(scope.map((n) => firstSeg(n).seg));
  const only = [...tops][0] ?? '';
  const wrapper = tops.size === 1 && scope.every((n) => n.includes('/')) && !BEPINEX_KINDS.has(only.toLowerCase()) ? `${only}/` : '';
  for (const n of scope) {
    const rel = n.slice(wrapper.length);
    const { seg, isFile } = firstSeg(rel);
    if (paper(seg, isFile)) continue;
    const kind = isFile ? '' : seg.toLowerCase();
    const rest = rel.slice(seg.length + 1);
    if (kind === 'config') plan.map.set(n, `BepInEx/config/${rest}`);
    else if (BEPINEX_KINDS.has(kind)) plan.map.set(n, `BepInEx/${kind}/${rest.toLowerCase().startsWith(`${mod.toLowerCase()}/`) ? rest : `${mod}/${rest}`}`);
    else plan.map.set(n, `BepInEx/plugins/${mod}/${rel}`);
  }
  plan.how = 'arranged';
  plan.notes.push(t('Плагин положен в BepInEx/plugins/{0}', mod));
  return plan;
}

// ---------- entry points

/** Whether Lattice knows how this game reads mods, beyond unpacking archives as they are. */
export function hasLayout(def: GameDef): boolean {
  return def.kind === 'bepinex' || def.id === 'stardewvalley' || !!MODELS[def.id];
}

/**
 * Decides where every file of an archive goes for this game. `modName` names
 * folders the mod needs for itself; `choice` is what the user picked earlier.
 */
export function planLayout(def: GameDef, rawNames: string[], modName: string, choice?: LayoutChoice): LayoutPlan {
  const names = cleanNames(rawNames);
  const mod = modFolderName(modName);
  if (def.kind === 'bepinex') return bepinexPlan(names, mod, choice);
  if (def.id === 'stardewvalley') return stardewPlan(names, mod, choice);
  const model = MODELS[def.id];
  if (model) return modelPlan(model, def, names, mod, choice);
  // a game Lattice has no picture of: as before — one wrapper folder comes off
  const plan = emptyPlan();
  const tops = new Set(names.map((n) => firstSeg(n).seg));
  const single = tops.size === 1 && names.every((n) => n.includes('/')) ? `${[...tops][0]}/` : '';
  const strip = single && (single.slice(0, -1).toLowerCase() === def.deployDir.toLowerCase() || def.stripSingleRoot) ? single : '';
  for (const n of names) plan.map.set(n, n.slice(strip.length));
  plan.how = strip ? 'arranged' : 'as-is';
  return plan;
}

/** The places a user can send files to by hand, for the picker. */
export function layoutDests(def: GameDef): LayoutDest[] {
  if (def.kind === 'bepinex') return BEPINEX_DESTS();
  if (def.id === 'stardewvalley') return STARDEW_DESTS();
  return MODELS[def.id]?.dests() ?? [{ id: '', label: t('Папка модов игры (как в архиве)') }];
}

// ---------- checking what is already staged

export interface StagedCheck {
  /** files the game reads where they are */
  ok: number;
  /** files that lie where nothing says the game looks */
  misplaced: string[];
}

/** Files that can only work from the right folder: when one is misplaced, the mod is broken for sure. */
const MUST_BE_PLACED = /\.(archive|xl|reds|esp|esm|esl|bsa|ba2|asi)$|(^|\/)(init\.lua|manifest\.json)$/i;

/** Looks at a staged mod (paths under the deploy root) and tells which files the game will not find. */
export function checkStaged(def: GameDef, files: string[]): StagedCheck & { broken: boolean } {
  const out = { ok: 0, misplaced: [] as string[], broken: false };
  const model = MODELS[def.id];
  const manifestDirs = def.id === 'stardewvalley' ? new Set(files.filter((f) => /^[^/]+\/manifest\.json$/i.test(f)).map((f) => f.slice(0, f.indexOf('/')).toLowerCase())) : new Set<string>();
  for (const f of files) {
    const { seg, isFile } = firstSeg(f);
    const low = seg.toLowerCase();
    let ok: boolean;
    if (seg === GAME_ROOT) ok = true;
    else if (def.kind === 'bepinex') ok = low === 'bepinex' || low === 'doorstop_libs' || low === 'unstripped_corlib' || (isFile && /^(winhttp\.dll|doorstop_config\.ini|\.doorstop_version|changelog\.txt|start_.*\.(sh|bat)|run_bepinex\.sh)$/i.test(seg));
    else if (def.id === 'stardewvalley') ok = !isFile && manifestDirs.has(low);
    else if (model) {
      const deployIsData = !!model.dataDir && def.deployDir.toLowerCase() === model.dataDir;
      if (deployIsData) ok = isFile ? !!model.dataFiles?.test(seg) || /\.(json|toml|txt|xml)$/i.test(seg) : !!model.dataDirs?.includes(low);
      else ok = isFile ? !!model.gameFiles?.test(seg) : model.gameDirs.includes(low);
    } else ok = true;
    if (ok) out.ok++;
    else out.misplaced.push(f);
  }
  out.broken = out.misplaced.length > 0 && (out.ok === 0 || out.misplaced.some((f) => MUST_BE_PLACED.test(f)));
  return out;
}
