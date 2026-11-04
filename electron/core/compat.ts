// Offline compatibility check of a profile: every link between mods and
// collections is verified against what is actually installed and enabled.
import type { Collection, CompatReport, InstalledMod, Issue, Profile } from '../../shared/types';
import { keyOf } from '../../shared/types';
import { gameVersionFits, loaderFits } from '../../shared/context';
import { satisfies } from '../../shared/versions';
import { computeOrder, providerIndex } from './loadorder';

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

export function checkCompatibility(profile: Profile, collections: Collection[], overlaps: FileOverlap[] = [], pluginCheck?: PluginCheck): CompatReport {
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
  const title = (key: string, fallback?: string) => profile.mods[key]?.title ?? fallback ?? key.split(':').slice(1).join(':');
  const ctx = profile.context;

  const dependents: Record<string, string[]> = {};
  for (const m of all) dependents[m.key] = [];

  for (const m of enabled) {
    if (!gameVersionFits(m.gameVersions, ctx.gameVersion)) {
      push({
        severity: 'error',
        code: 'incompatible-game',
        subject: m.key,
        related: [],
        message: `«${m.title}» ${m.version} не поддерживает версию игры ${ctx.gameVersion}.`,
        fix: { kind: 'update', label: 'Подобрать совместимую версию', key: m.key, ref: m.ref },
      });
    }
    if (!loaderFits(m.loaders, ctx.loader)) {
      push({
        severity: 'error',
        code: 'incompatible-loader',
        subject: m.key,
        related: [],
        message: `«${m.title}» собран для ${m.loaders.join(', ')}, а профиль использует ${ctx.loader}.`,
        fix: { kind: 'update', label: 'Подобрать версию под загрузчик', key: m.key, ref: m.ref },
      });
    }

    for (const d of m.deps) {
      const depKey = keyOf(d.ref);
      const depName = d.name ?? title(depKey);
      const live = (enabledProviders.get(depKey) ?? []).filter((p) => p.key !== m.key);

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
              message: `«${m.title}» требует «${off[0].title}», но он выключен.`,
              fix: { kind: 'enable', label: `Включить «${off[0].title}»`, key: off[0].key },
            });
          } else {
            push({
              severity: 'error',
              code: 'missing-dep',
              subject: m.key,
              related: [depKey],
              message: `«${m.title}» требует «${depName}», но он не установлен.`,
              fix: { kind: 'install', label: `Установить «${depName}»`, ref: d.ref, versionId: d.versionId },
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
            message: `«${m.title}» требует «${exact.title}» ${d.range}, установлена ${exact.version}.`,
            fix: { kind: 'update', label: `Обновить «${exact.title}»`, key: exact.key, ref: exact.ref },
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
            message: `«${m.title}» рекомендует «${depName}».`,
            fix: { kind: 'install', label: `Установить «${depName}»`, ref: d.ref, versionId: d.versionId },
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
            message: `«${m.title}» несовместим с «${p.title}».`,
            fix: { kind: 'disable', label: `Выключить «${p.title}»`, key: p.key },
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
          message: `Коллекция «${c.name}» строится поверх «${link.name ?? link.collectionId}», но та не применена.`,
          fix: collections.some((x) => x.id === link.collectionId)
            ? { kind: 'apply-collection', label: `Применить «${link.name ?? link.collectionId}»`, collectionId: link.collectionId }
            : undefined,
        });
      } else if (link.range && !satisfies(target.version, link.range)) {
        push({
          severity: 'warning',
          code: 'collection-missing',
          subject: `collection:${c.id}`,
          related: [`collection:${target.id}`],
          message: `«${c.name}» ожидает «${target.name}» ${link.range}, применена ${target.version}.`,
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
        message: `Коллекции «${c.name}» и «${applied.get(link.collectionId)!.name}» несовместимы${link.reason ? `: ${link.reason}` : ''}.`,
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
      message: `Циклический порядок загрузки: ${cyc.map((k) => `«${title(k)}»`).join(' → ')}.`,
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
          message: `Плагин ${p.name} из «${title(p.owner)}» требует мастер-файл ${m}, а его нет ни в модах, ни в игре.`,
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
      message: `«${title(p.b)}» и «${title(p.a)}» меняют одни и те же файлы (${p.count}, напр. ${p.sample}). Сейчас побеждает «${title(p.b)}».`,
      fix: { kind: 'add-rule', label: `Закрепить: «${title(p.b)}» после «${title(p.a)}»`, rule: { subject: p.b, kind: 'after', other: p.a } },
    });
  }

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  const score = enabled.length === 0 ? 100 : Math.max(0, Math.min(100, 100 - errors * 18 - warnings * 5));
  issues.sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
  return { score, errors, warnings, issues, order, dependents };
}

function sevRank(s: Issue['severity']) {
  return s === 'error' ? 0 : s === 'warning' ? 1 : 2;
}

function dependsOn(mods: Record<string, InstalledMod>, a: string, b: string): boolean {
  return (mods[a]?.deps ?? []).some((d) => d.kind === 'requires' && keyOf(d.ref) === b);
}
