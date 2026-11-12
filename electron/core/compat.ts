// Offline compatibility check of a profile: every link between mods and
// collections is verified against what is actually installed and enabled.
import type { Collection, CompatReport, InstalledMod, Issue, Profile } from '../../shared/types';
import { keyOf } from '../../shared/types';
import { gameVersionFits, loaderFits, loaderLabel } from '../../shared/context';
import { matchesStrict, satisfies, violatesStrict } from '../../shared/versions';
import { computeOrder, providerIndex } from './loadorder';
import { builtinIds, jarView, type JarMeta } from './jarmeta';
import { t } from '../../shared/i18n';

/** What is known about a project mods point at but the profile does not have. */
export interface DepInfo {
  title?: string;
  /** loaders the project is released for, when its source says */
  loaders?: string[];
  gameVersions?: string[];
}

export interface FileOverlap {
  path: string;
  keys: string[];
}

/** A Bethesda plugin a mod ships, with the master files its header lists. */
export interface PluginInfo {
  owner: string;
  name: string;
  masters: string[];
}

export interface PluginCheck {
  plugins: PluginInfo[];
  /** plugin files present anyway: the game's own masters and anything in Data */
  available: string[];
}

export function checkCompatibility(
  profile: Profile,
  collections: Collection[],
  overlaps: FileOverlap[] = [],
  pluginCheck?: PluginCheck,
  /** what each Minecraft mod's jars declare (key -> merged metadata) */
  jars?: Map<string, JarMeta>,
  /** names and loaders of projects that are referenced but not installed */
  known?: Map<string, DepInfo>,
): CompatReport {
  const all = Object.values(profile.mods);
  const enabled = all.filter((m) => m.enabled);
  const enabledProviders = providerIndex(enabled);
  const anyProviders = providerIndex(all);
  const issues: Issue[] = [];
  const seen = new Set<string>();
  const push = (i: Omit<Issue, 'id'>) => {
    const id = `${i.code}:${i.subject}:${i.related.join(',')}`;
    if (seen.has(id)) return;
    seen.add(id);
    issues.push({ ...i, id });
  };
  const title = (key: string, fallback?: string) => profile.mods[key]?.title ?? fallback ?? known?.get(key)?.title ?? key.split(':').slice(1).join(':');
  const ctx = profile.context;
  const loaderName = loaderLabel(ctx.loader);
  // what the mod's own file says to the loader the profile runs: for Minecraft the loader
  // decides by it alone whether the game starts, whatever a catalogue lists
  const view = (key: string) => (jars ? jarView(jars.get(key), ctx.loader) : undefined);

  const dependents: Record<string, string[]> = {};
  for (const m of all) dependents[m.key] = [];

  for (const m of enabled) {
    if (!gameVersionFits(m.gameVersions, ctx.gameVersion)) {
      push({
        severity: 'error',
        code: 'incompatible-game',
        subject: m.key,
        related: [],
        message: t('«{0}» {1} не поддерживает версию игры {2}.', m.title, m.version, ctx.gameVersion),
        fix: { kind: 'update', label: t('Подобрать совместимую версию'), key: m.key, ref: m.ref },
      });
    }
    if (!loaderFits(m.loaders, ctx.loader)) {
      push({
        severity: 'error',
        code: 'incompatible-loader',
        subject: m.key,
        related: [],
        message: t('«{0}» собран для {1}, а профиль использует {2}.', m.title, m.loaders.join(', '), ctx.loader),
        fix: { kind: 'update', label: t('Подобрать версию под загрузчик'), key: m.key, ref: m.ref },
      });
    }

    for (const d of m.deps) {
      const depKey = keyOf(d.ref);
      const depName = d.name ?? title(depKey);
      const live = (enabledProviders.get(depKey) ?? []).filter((p) => p.key !== m.key);
      const info = known?.get(depKey);
      // the project is not released for this loader at all: it cannot be what the mod needs here
      const otherLoader = !!ctx.loader && !!info?.loaders?.length && !loaderFits(info.loaders, ctx.loader);

      if (d.kind === 'requires') {
        for (const p of live) (dependents[p.key] ??= []).push(m.key);
        if (live.length === 0) {
          const off = (anyProviders.get(depKey) ?? []).filter((p) => p.key !== m.key);
          if (off.length) {
            push({
              severity: 'error',
              code: 'disabled-dep',
              subject: m.key,
              related: [off[0].key],
              message: t('«{0}» требует «{1}», но он выключен.', m.title, off[0].title),
              fix: { kind: 'enable', label: t('Включить «{0}»', off[0].title), key: off[0].key },
            });
          } else if (otherLoader) {
            push({
              severity: 'info',
              code: 'catalog-dep',
              subject: m.key,
              related: [depKey],
              message: t('«{0}» в каталоге ссылается на «{1}», но его нет для {2}: так бывает, когда один файл мода собран для нескольких загрузчиков или в сборке стоит порт. Для запуска он не нужен.', m.title, depName, loaderName),
            });
          } else if (!d.user && view(m.key)?.known) {
            // the mod file itself does not ask for it (or the profile has it under another name): the game starts
            const can = !!info?.loaders?.length;
            push({
              severity: can ? 'warning' : 'info',
              code: 'catalog-dep',
              subject: m.key,
              related: [depKey],
              message: t('Каталог считает «{1}» обязательным для «{0}», а сам файл мода его не требует: игра запустится. Если «{0}» не заработает, поставьте «{1}».', m.title, depName),
              fix: { kind: 'install', label: t('Установить «{0}»', depName), ref: d.ref, versionId: d.versionId },
            });
          } else {
            push({
              severity: 'error',
              code: 'missing-dep',
              subject: m.key,
              related: [depKey],
              message: t('«{0}» требует «{1}», но он не установлен.', m.title, depName),
              fix: { kind: 'install', label: t('Установить «{0}»', depName), ref: d.ref, versionId: d.versionId },
            });
          }
          continue;
        }
        const exact = live.find((p) => p.key === depKey);
        if (exact && d.range && !satisfies(exact.version, d.range)) {
          push({
            severity: 'error',
            code: 'version-mismatch',
            subject: m.key,
            related: [exact.key],
            message: t('«{0}» требует «{1}» {2}, установлена {3}.', m.title, exact.title, d.range, exact.version),
            fix: { kind: 'update', label: t('Обновить «{0}»', exact.title), key: exact.key, ref: exact.ref },
          });
        }
      } else if (d.kind === 'recommends') {
        for (const p of live) (dependents[p.key] ??= []).push(m.key);
        if (live.length === 0 && !(anyProviders.get(depKey) ?? []).length) {
          push({
            severity: 'info',
            code: 'recommended',
            subject: m.key,
            related: [depKey],
            message: t('«{0}» рекомендует «{1}».', m.title, depName),
            fix: { kind: 'install', label: t('Установить «{0}»', depName), ref: d.ref, versionId: d.versionId },
          });
        }
      } else if (d.kind === 'conflicts') {
        for (const p of live) {
          if (d.range && !satisfies(p.version, d.range)) continue;
          push({
            severity: 'error',
            code: 'conflict',
            subject: m.key,
            related: [p.key],
            message: t('«{0}» несовместим с «{1}».', m.title, p.title),
            fix: { kind: 'disable', label: t('Выключить «{0}»', p.title), key: p.key },
          });
        }
      }
    }
  }

  // Links between collections applied to this profile.
  const applied = new Map(collections.filter((c) => profile.collections.includes(c.id)).map((c) => [c.id, c]));
  for (const c of applied.values()) {
    for (const link of c.requires) {
      const target = applied.get(link.collectionId);
      if (!target) {
        push({
          severity: 'warning',
          code: 'collection-missing',
          subject: `collection:${c.id}`,
          related: [`collection:${link.collectionId}`],
          message: t('Коллекция «{0}» строится поверх «{1}», но та не применена.', c.name, link.name ?? link.collectionId),
          fix: collections.some((x) => x.id === link.collectionId)
            ? { kind: 'apply-collection', label: t('Применить «{0}»', link.name ?? link.collectionId), collectionId: link.collectionId }
            : undefined,
        });
      } else if (link.range && !satisfies(target.version, link.range)) {
        push({
          severity: 'warning',
          code: 'collection-missing',
          subject: `collection:${c.id}`,
          related: [`collection:${target.id}`],
          message: t('«{0}» ожидает «{1}» {2}, применена {3}.', c.name, target.name, link.range, target.version),
        });
      }
    }
    for (const link of c.conflicts) {
      if (!applied.has(link.collectionId)) continue;
      push({
        severity: 'error',
        code: 'collection-conflict',
        subject: `collection:${c.id}`,
        related: [`collection:${link.collectionId}`],
        message: t('Коллекции «{0}» и «{1}» несовместимы{2}.', c.name, applied.get(link.collectionId)!.name, link.reason ? `: ${link.reason}` : ''),
      });
    }
  }

  const { order, cycles } = computeOrder(all, profile.rules);
  for (const cyc of cycles) {
    push({
      severity: 'error',
      code: 'cycle',
      subject: cyc[0],
      related: cyc.slice(1),
      message: t('Правила порядка противоречат друг другу: {0}. Уберите одно из правил в карточке мода.', cyc.map((k) => `«${title(k)}»`).join(' → ')),
    });
  }

  // Plugin masters: every master a plugin lists must be loaded too.
  if (pluginCheck) {
    const have = new Set([...pluginCheck.available, ...pluginCheck.plugins.map((p) => p.name)].map((n) => n.toLowerCase()));
    for (const p of pluginCheck.plugins) {
      if (!profile.mods[p.owner]?.enabled) continue;
      for (const m of p.masters) {
        if (have.has(m.toLowerCase())) continue;
        push({
          severity: 'error',
          code: 'missing-master',
          subject: p.owner,
          related: [],
          message: t('Плагин {0} из «{1}» требует мастер-файл {2}, а его нет ни в модах, ни в игре.', p.name, title(p.owner), m),
        });
      }
    }
  }

  // Two mods writing the same file with no rule saying which one wins.
  const ruled = new Set(profile.rules.flatMap((r) => [`${r.subject}|${r.other}`, `${r.other}|${r.subject}`]));
  const pairs = new Map<string, { a: string; b: string; count: number; sample: string }>();
  const pos = new Map(order.map((k, i) => [k, i]));
  for (const o of overlaps) {
    const ks = o.keys.filter((k) => profile.mods[k]?.enabled).sort((a, b) => pos.get(a)! - pos.get(b)!);
    for (let i = 0; i < ks.length; i++)
      for (let j = i + 1; j < ks.length; j++) {
        const id = `${ks[i]}|${ks[j]}`;
        if (ruled.has(id) || dependsOn(profile.mods, ks[j], ks[i])) continue;
        const p = pairs.get(id);
        if (p) p.count++;
        else pairs.set(id, { a: ks[i], b: ks[j], count: 1, sample: o.path });
      }
  }
  for (const p of pairs.values()) {
    push({
      severity: 'warning',
      code: 'file-conflict',
      subject: p.b,
      related: [p.a],
      message: t('«{0}» и «{1}» меняют одни и те же файлы ({2}, напр. {3}). Сейчас побеждает «{4}».', title(p.b), title(p.a), p.count, p.sample, title(p.b)),
      fix: { kind: 'add-rule', label: t('Закрепить: «{0}» после «{1}»', title(p.b), title(p.a)), rule: { subject: p.b, kind: 'after', other: p.a } },
    });
  }

  // The same mod taken from two sources (say Modrinth and GitHub): links only
  // join mods of one source, so Lattice compares names to catch the double.
  const byName = new Map<string, InstalledMod>();
  for (const m of enabled) {
    const name = m.title.toLowerCase().replace(/\b(fabric|forge|neoforge|quilt|mod)\b/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
    if (name.length < 3) continue;
    const other = byName.get(name);
    if (!other) byName.set(name, m);
    else if (other.ref.source !== m.ref.source)
      push({
        severity: 'warning',
        code: 'duplicate',
        subject: m.key,
        related: [other.key],
        message: t('«{0}» похоже на «{1}» из другого источника. Две копии одного мода обычно конфликтуют.', m.title, other.title),
        fix: { kind: 'disable', label: t('Выключить «{0}»', m.title), key: m.key },
      });
  }

  // Dependencies written in the jars themselves: the loader stops the game when one is missing.
  // Each jar answers for the loader of the profile only: what it asks Quilt or Forge for
  // does not matter on Fabric.
  if (jars?.size) {
    const live = [...jars].filter(([k]) => profile.mods[k]?.enabled).map(([k, m]) => ({ k, m, v: jarView(m, ctx.loader) }));
    const provided = builtinIds(ctx.loader);
    for (const x of live) for (const id of x.v.ids) provided.add(id.toLowerCase());
    for (const { k, m, v } of live) {
      const fixable = profile.mods[k].ref.source !== 'local';
      if (ctx.loader && m.loaders?.length && !loaderFits(m.loaders, ctx.loader)) {
        push({
          severity: 'error',
          code: 'incompatible-loader',
          subject: k,
          related: [],
          message: t('«{0}» сделан для {1}, а профиль использует {2}: так указано в самом файле мода.', title(k), m.loaders.join(' / '), ctx.loader),
          fix: fixable ? { kind: 'update', label: t('Подобрать версию под загрузчик'), key: k } : undefined,
        });
        continue; // the loader will not read this jar: what it asks for is beside the point
      }
      if (!v.known) continue;
      // the game version the mod file itself asks for (works for any source, local files too)
      const mc = v.depends.find((d) => d.id.toLowerCase() === 'minecraft');
      if (mc && violatesStrict(ctx.gameVersion, mc.range)) {
        push({
          severity: 'error',
          code: 'incompatible-game',
          subject: k,
          related: [],
          message: t('«{0}» рассчитан на Minecraft {1}, а профиль — {2}: так указано в самом файле мода.', title(k), mc.range ?? '', ctx.gameVersion ?? ''),
          fix: fixable ? { kind: 'update', label: t('Подобрать совместимую версию'), key: k } : undefined,
        });
      }
      const own = new Set(v.ids.map((x) => x.toLowerCase()));
      for (const d of v.depends) {
        const id = d.id.toLowerCase();
        if (provided.has(id) || own.has(id)) continue;
        push({
          severity: 'error',
          code: 'jar-dependency',
          subject: k,
          related: [],
          message: t('«{0}» требует мод «{1}», а его нет в профиле. Это указано в самом файле мода: без него игра не запустится.', title(k), d.id),
          fix: profile.mods[k].ref.source === 'modrinth' ? { kind: 'install', label: t('Найти «{0}» на Modrinth и установить', d.id), ref: { source: 'modrinth', projectId: id.replace(/_/g, '-') } } : undefined,
        });
      }
      for (const b of v.breaks) {
        const id = b.id.toLowerCase();
        const other = live.find((o) => o.k !== k && o.v.ids.some((x) => x.toLowerCase() === id));
        // a breaks entry usually names old versions only: it counts when the installed one is in the range
        if (!other || !matchesStrict(other.v.versions[id], b.range)) continue;
        push({
          severity: 'error',
          code: 'jar-breaks',
          subject: k,
          related: [other.k],
          message: t('«{0}» не работает вместе с «{1}»: это указано в самом файле мода.', title(k), title(other.k)),
          fix: { kind: 'disable', label: t('Выключить «{0}»', title(other.k)), key: other.k },
        });
      }
    }
  }

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  const score = scoreOf(enabled.length, errors, warnings);
  issues.sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
  const names: Record<string, string> = {};
  for (const [k, v] of known ?? []) if (v.title) names[k] = v.title;
  return { score, errors, warnings, issues, order, dependents, names };
}

/** How a profile scores for a number of errors and warnings. */
function scoreOf(enabled: number, errors: number, warnings: number): number {
  return enabled === 0 ? 100 : Math.max(0, Math.min(100, 100 - errors * 18 - warnings * 5));
}

/** Adds problems found elsewhere (in the mods' files, in the game's log) to a report. */
export function withIssues(report: CompatReport, extra: Omit<Issue, 'id'>[], enabled: number): CompatReport {
  if (extra.length === 0) return report;
  const seen = new Set(report.issues.map((i) => i.id));
  const issues = [...report.issues];
  for (const i of extra) {
    const id = `${i.code}:${i.subject}:${i.related.join(',')}`;
    if (seen.has(id)) continue;
    seen.add(id);
    issues.push({ ...i, id });
  }
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  issues.sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
  return { ...report, issues, errors, warnings, score: scoreOf(enabled, errors, warnings) };
}

function sevRank(s: Issue['severity']) {
  return s === 'error' ? 0 : s === 'warning' ? 1 : 2;
}

function dependsOn(mods: Record<string, InstalledMod>, a: string, b: string): boolean {
  return (mods[a]?.deps ?? []).some((d) => d.kind === 'requires' && keyOf(d.ref) === b);
}
