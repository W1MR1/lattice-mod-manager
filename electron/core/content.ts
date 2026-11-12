// What the mods of a game need in order to work, read from their own files:
// whether each file lies where the game looks, which loader or framework the
// files are written for (a .reds script needs redscript, an SKSE plugin needs
// SKSE), and — for Stardew Valley — what every manifest.json asks for.
// A catalogue can be wrong or silent about all of this; the files are not.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GameDef, Issue, ModRef } from '../../shared/types';
import { checkStaged, GAME_ROOT } from './layout';
import { t } from '../../shared/i18n';

export interface StagedMod {
  key: string;
  title: string;
  /** staged folder */
  dir: string;
  /** files under the deploy root (posix) */
  files: string[];
  /** staged by a version that did not lay archives out: staging it again may be all it takes */
  legacy: boolean;
  /** the archive is still at hand, so the mod can be laid out again */
  canRestage: boolean;
}

type NewIssue = Omit<Issue, 'id'>;

interface Framework {
  id: string;
  name: string;
  /** files of a mod that only work with the framework (paths under the deploy root, lower case) */
  used: RegExp;
  /** a file that shows the framework is there: under the deploy root, or `GAME_ROOT/…` for the game folder */
  marker: string[];
  /** where Lattice can take it from */
  ref?: ModRef;
  /** where the user takes it from when Lattice cannot */
  hint?: string;
}

const FRAMEWORKS: Record<string, Framework[]> = {
  cyberpunk2077: [
    { id: 'cet', name: 'Cyber Engine Tweaks', used: /^bin\/x64\/plugins\/cyber_engine_tweaks\/mods\/[^/]+\/init\.lua$/, marker: ['bin/x64/plugins/cyber_engine_tweaks.asi'], ref: { source: 'github', projectId: 'yamashi/CyberEngineTweaks' } },
    { id: 'red4ext', name: 'RED4ext', used: /^red4ext\/plugins\/.+\.dll$/, marker: ['red4ext/RED4ext.dll'], ref: { source: 'github', projectId: 'wopss/RED4ext' } },
    { id: 'redscript', name: 'redscript', used: /^r6\/scripts\/.+\.reds$/, marker: ['engine/config/base/scripts.ini', 'engine/tools/scc.exe'], ref: { source: 'github', projectId: 'jac3km4/redscript' } },
    { id: 'archivexl', name: 'ArchiveXL', used: /^archive\/pc\/mod\/.+\.xl$/, marker: ['red4ext/plugins/ArchiveXL/ArchiveXL.dll'], ref: { source: 'github', projectId: 'psiberx/cp2077-archive-xl' } },
    { id: 'tweakxl', name: 'TweakXL', used: /^r6\/tweaks\/.+\.(ya?ml|tweak)$/, marker: ['red4ext/plugins/TweakXL/TweakXL.dll'], ref: { source: 'github', projectId: 'psiberx/cp2077-tweak-xl' } },
  ],
  skyrimse: [{ id: 'skse', name: 'SKSE64', used: /^skse\/plugins\/.+\.dll$/, marker: [`${GAME_ROOT}/skse64_loader.exe`], hint: 'skse.silverlock.org' }],
  fallout4: [{ id: 'f4se', name: 'F4SE', used: /^f4se\/plugins\/.+\.dll$/, marker: [`${GAME_ROOT}/f4se_loader.exe`], hint: 'f4se.silverlock.org' }],
  stardewvalley: [{ id: 'smapi', name: 'SMAPI', used: /^[^/]+\/manifest\.json$/, marker: [`${GAME_ROOT}/StardewModdingAPI.exe`, `${GAME_ROOT}/StardewModdingAPI.dll`], hint: 'smapi.io' }],
};

/** The BepInEx pack of each game on Thunderstore. */
const BEPINEX_PACK: Record<string, string> = {
  'lethal-company': 'BepInEx-BepInExPack',
  valheim: 'denikson-BepInExPack_Valheim',
  riskofrain2: 'bbepis-BepInExPack',
  'content-warning': 'BepInEx-BepInExPack',
};

function frameworksOf(def: GameDef, bepinexPack?: string): Framework[] {
  if (def.kind === 'bepinex') {
    const pack = bepinexPack ?? BEPINEX_PACK[def.id];
    return [{ id: 'bepinex', name: 'BepInEx', used: /^bepinex\/(plugins|patchers)\/.+\.dll$/, marker: ['BepInEx/core/BepInEx.dll', 'BepInEx/core/BepInEx.Core.dll', 'BepInEx/core/BepInEx.Preloader.dll'], ref: pack ? { source: 'thunderstore', projectId: pack } : undefined, hint: 'thunderstore.io' }];
  }
  return FRAMEWORKS[def.id] ?? [];
}

const exists = (p: string) =>
  fs.stat(p).then(
    () => true,
    () => false,
  );

/** JSON as mod authors write it: with comments, trailing commas and a BOM. */
export function parseLooseJson<T>(text: string): T | null {
  const clean = text
    .replace(/^\uFEFF/, '')
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n\r]*|\/\*[\s\S]*?\*\//g, (_all, str: string | undefined) => str ?? '')
    .replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(clean) as T;
  } catch {
    return null;
  }
}

interface SmapiManifest {
  Name?: string;
  UniqueID?: string;
  ContentPackFor?: { UniqueID?: string };
  Dependencies?: { UniqueID?: string; IsRequired?: boolean }[];
}

const manifestCache = new Map<string, { mtime: number; m: SmapiManifest | null }>();

async function smapiManifest(file: string): Promise<SmapiManifest | null> {
  const st = await fs.stat(file).catch(() => null);
  if (!st) return null;
  const hit = manifestCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.m;
  const m = parseLooseJson<SmapiManifest>(await fs.readFile(file, 'utf8').catch(() => ''));
  manifestCache.set(file, { mtime: st.mtimeMs, m });
  return m;
}

/** The names SMAPI knows a staged Stardew mod by (the Name and UniqueID of each manifest), lower case. */
export async function smapiNames(mod: StagedMod): Promise<string[]> {
  const out: string[] = [];
  for (const f of mod.files) {
    if (!/^[^/]+\/manifest\.json$/i.test(f)) continue;
    const m = await smapiManifest(path.join(mod.dir, f));
    if (m?.Name) out.push(m.Name.toLowerCase());
  }
  return out;
}

/**
 * Problems the files of the enabled mods show by themselves. `gameDir` is the
 * game folder; frameworks already installed there by hand count as present.
 */
export async function contentIssues(def: GameDef, mods: StagedMod[], gameDir: string, opts: { bepinexPack?: string } = {}): Promise<NewIssue[]> {
  const out: NewIssue[] = [];
  if (def.kind === 'minecraft') return out;
  const deployRoot = path.join(gameDir, def.deployDir);

  // 1. files that lie where the game does not look
  for (const m of mods) {
    const c = checkStaged(def, m.files);
    if (!c.broken) continue;
    const sample = c.misplaced.slice(0, 2).join(', ');
    out.push({
      severity: c.ok === 0 ? 'error' : 'warning',
      code: 'misplaced',
      subject: m.key,
      related: [],
      message:
        c.ok === 0
          ? t('Файлы «{0}» лежат не там, где игра их ищет (например, {1}): мод не заработает.', m.title, sample)
          : t('Часть файлов «{0}» лежит не там, где игра их ищет ({1}): мод может работать не полностью.', m.title, sample),
      fix: !m.canRestage
        ? undefined
        : m.legacy
          ? { kind: 'restage', label: t('Разложить заново'), key: m.key }
          : { kind: 'relayout', label: t('Выбрать, что и куда ставить'), key: m.key },
    });
  }

  // 2. loaders and frameworks the files are written for
  const all = new Set(mods.flatMap((m) => m.files.map((f) => f.toLowerCase())));
  for (const fw of frameworksOf(def, opts.bepinexPack)) {
    const users = mods.filter((m) => m.files.some((f) => fw.used.test(f.toLowerCase())));
    if (users.length === 0) continue;
    let present = fw.marker.some((mk) => all.has(mk.toLowerCase()));
    for (const mk of fw.marker) {
      if (present) break;
      present = await exists(mk.startsWith(`${GAME_ROOT}/`) ? path.join(gameDir, mk.slice(GAME_ROOT.length + 1)) : path.join(deployRoot, mk));
    }
    if (present) continue;
    for (const m of users.slice(0, 12)) {
      out.push({
        severity: 'error',
        code: 'needs-framework',
        subject: m.key,
        related: fw.ref ? [`${fw.ref.source}:${fw.ref.projectId}`] : [],
        message: fw.ref
          ? t('«{0}» работает только с {1}, а он не установлен: игра этот мод не загрузит.', m.title, fw.name)
          : t('«{0}» работает только с {1}, а он не установлен: игра этот мод не загрузит. Скачайте {1} с {2} и перетащите архив в окно Lattice.', m.title, fw.name, fw.hint ?? ''),
        fix: fw.ref ? { kind: 'install', label: t('Установить {0}', fw.name), ref: fw.ref } : undefined,
      });
    }
  }

  // 3. Stardew Valley: what each manifest.json asks for (SMAPI skips a mod whose dependency is missing)
  if (def.id === 'stardewvalley') {
    const manifests: { mod: StagedMod; m: SmapiManifest }[] = [];
    for (const mod of mods) {
      for (const f of mod.files) {
        if (!/^[^/]+\/manifest\.json$/i.test(f)) continue;
        const m = await smapiManifest(path.join(mod.dir, f));
        if (m) manifests.push({ mod, m });
      }
    }
    const have = new Set(manifests.map((x) => x.m.UniqueID?.toLowerCase()).filter(Boolean));
    for (const { mod, m } of manifests) {
      const needs = [m.ContentPackFor?.UniqueID, ...(m.Dependencies ?? []).filter((d) => d.IsRequired !== false).map((d) => d.UniqueID)].filter((x): x is string => !!x);
      for (const id of new Set(needs)) {
        if (have.has(id.toLowerCase())) continue;
        out.push({
          severity: 'error',
          code: 'jar-dependency',
          subject: mod.key,
          related: [],
          message: t('«{0}» требует мод «{1}», а его нет в профиле. Это указано в manifest.json самого мода: SMAPI его пропустит.', mod.title, id),
        });
      }
    }
  }
  return out;
}
