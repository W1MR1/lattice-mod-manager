// Install planner: picks versions for requested mods and their whole dependency
// closure so that every constraint (game version, loader, ranges, conflicts) holds.
// Installed mods stay pinned unless a request or an allowed update changes them.
import type {
  GameContext,
  InstallPlan,
  InstallReason,
  InstalledMod,
  Issue,
  ModRef,
  ModVersion,
  PlanItem,
  PlanRequest,
  Profile,
} from '../../shared/types';
import { keyOf } from '../../shared/types';
import { fitsContext, loaderFits, loaderLabel } from '../../shared/context';
import { compareVersions, satisfies } from '../../shared/versions';
import { t } from '../../shared/i18n';

export interface ProjectMeta {
  title: string;
  iconUrl?: string;
  author?: string;
  /** loaders and game versions the project is released for, when the source lists them */
  loaders?: string[];
  gameVersions?: string[];
}

export interface VersionProvider {
  versions(ref: ModRef, ctx: GameContext): Promise<ModVersion[]>;
  meta(refs: ModRef[]): Promise<Map<string, ProjectMeta>>;
}

export interface ResolveInput {
  profile: Profile;
  requests: PlanRequest[];
  reason: InstallReason;
  /** `collection:<id>` or omitted for the user */
  requestedBy?: string;
  includeRecommended: boolean;
  /** let the planner move installed mods to another version when a constraint demands it */
  allowUpdates: boolean;
  label: string;
}

interface Constraint {
  from: string;
  range?: string;
  /** preferred exact version (soft: Modrinth pins are advisory) */
  versionId?: string;
}

interface Pick {
  version: ModVersion;
  installed?: InstalledMod;
}

export function installedAsVersion(m: InstalledMod): ModVersion {
  return {
    ref: m.ref,
    versionId: m.versionId,
    version: m.version,
    gameVersions: m.gameVersions,
    loaders: m.loaders,
    published: m.installedAt,
    files: m.files,
    deps: m.deps,
    provides: m.provides,
  };
}

const sortNewest = (a: ModVersion, b: ModVersion) => {
  const t = Date.parse(b.published) - Date.parse(a.published);
  if (!Number.isNaN(t) && t !== 0) return t;
  return compareVersions(b.version, a.version);
};

export async function resolvePlan(input: ResolveInput, provider: VersionProvider, planId: string): Promise<InstallPlan> {
  const { profile, requests } = input;
  const ctx = profile.context;
  const issues: Issue[] = [];
  const issue = (i: Omit<Issue, 'id'>) => {
    const id = `${i.code}:${i.subject}:${i.related.join(',')}`;
    if (!issues.some((x) => x.id === id)) issues.push({ ...i, id });
  };

  const selected = new Map<string, Pick>();
  const constraints = new Map<string, Constraint[]>();
  const requested = new Map<string, PlanRequest>();
  const versionCache = new Map<string, ModVersion[]>();
  const names = new Map<string, string>();

  const addConstraint = (key: string, c: Constraint) => {
    const list = constraints.get(key) ?? [];
    if (!list.some((x) => x.from === c.from && x.range === c.range && x.versionId === c.versionId)) list.push(c);
    constraints.set(key, list);
  };
  const dropConstraintsFrom = (from: string) => {
    for (const [k, list] of constraints) constraints.set(k, list.filter((c) => c.from !== from));
  };
  const fits = (v: ModVersion, key: string) => (constraints.get(key) ?? []).every((c) => satisfies(v.version, c.range));
  const providedBy = (key: string): string | undefined => {
    for (const [k, p] of selected) if (k !== key && p.version.provides?.includes(key)) return k;
    return undefined;
  };
  const versionsOf = async (ref: ModRef) => {
    const k = keyOf(ref);
    let list = versionCache.get(k);
    if (!list) {
      try {
        list = (await provider.versions(ref, ctx)).slice().sort(sortNewest);
      } catch (e) {
        list = [];
        issue({
          severity: 'error',
          code: 'unresolvable',
          subject: k,
          related: [],
          message: t('Не удалось получить версии «{0}»: {1}', names.get(k) ?? ref.projectId, (e as Error).message),
        });
      }
      versionCache.set(k, list);
    }
    return list;
  };

  // Seed: installed enabled mods are part of the solution and contribute constraints.
  for (const m of Object.values(profile.mods)) {
    if (!m.enabled) continue;
    selected.set(m.key, { version: installedAsVersion(m), installed: m });
    names.set(m.key, m.title);
    for (const d of m.deps) if (d.kind === 'requires') addConstraint(keyOf(d.ref), { from: m.key, range: d.range });
  }

  const queue: string[] = [];
  for (const r of requests) {
    const k = keyOf(r.ref);
    requested.set(k, r);
    if (r.title) names.set(k, r.title);
    addConstraint(k, { from: r.by ?? input.requestedBy ?? 'user', range: r.range, versionId: r.versionId });
    queue.push(k);
  }

  const enqueueDeps = (key: string, v: ModVersion) => {
    for (const d of v.deps) {
      const want = d.kind === 'requires' || (input.includeRecommended && d.kind === 'recommends');
      if (!want) continue;
      const dk = keyOf(d.ref);
      if (d.name) names.set(dk, d.name);
      addConstraint(dk, { from: key, range: d.range, versionId: d.versionId });
      queue.push(dk);
    }
  };

  let guard = 0;
  while (queue.length && guard++ < 4000) {
    const key = queue.shift()!;
    const cur = selected.get(key);
    const req = requested.get(key);
    const cons = constraints.get(key) ?? [];
    if (cons.length === 0 && !req) continue; // nobody needs it any more

    const wantsSpecific = req?.versionId && cur?.version.versionId !== req.versionId;
    const wantsRefresh = req && !req.versionId && cur?.installed && input.allowUpdates;
    if (cur && fits(cur.version, key) && fitsContext(cur.version, ctx) && !wantsSpecific && !wantsRefresh) continue;

    if (!cur) {
      const via = providedBy(key);
      if (via) continue; // satisfied by a drop-in replacement
    }

    const ref = req?.ref ?? refFromKey(key);
    const all = await versionsOf(ref);
    const candidates = all.filter((v) => fitsContext(v, ctx) && fits(v, key));
    if (candidates.length === 0) {
      const why = cons
        .filter((c) => c.range)
        .map((c) => `${c.from === 'user' ? t('вы') : names.get(c.from) ?? c.from}: ${c.range}`)
        .join('; ');
      const total = all.length;
      // A dependency that is not released for this loader at all cannot be what the mod needs
      // here: files built for several loaders list the needs of each. It is left out, not an error.
      if (!req && total > 0 && ctx.loader && !all.some((v) => loaderFits(v.loaders, ctx.loader))) {
        issue({
          severity: 'info',
          code: 'catalog-dep',
          subject: key,
          related: cons.map((c) => c.from).filter((f) => f !== 'user'),
          message: t(
            '«{0}» есть только для других загрузчиков, не для {1}: пропущен. В каталоге на него ссылается {2} — так бывает, когда один файл мода собран для нескольких загрузчиков.',
            key,
            loaderLabel(ctx.loader),
            cons
              .filter((c) => c.from !== 'user' && !c.from.startsWith('collection:'))
              .map((c) => `«${c.from}»`)
              .join(', ') || '—',
          ),
        });
        constraints.delete(key);
        continue;
      }
      issue({
        severity: 'error',
        code: 'unresolvable',
        subject: key,
        related: cons.map((c) => c.from).filter((f) => f !== 'user'),
        message:
          total === 0
            ? t('«{0}» не найден в источнике.', names.get(key) ?? key)
            : t('Нет версии «{0}» для {1}{2}.', names.get(key) ?? key, ctxLabel(ctx), why ? t(' (ограничения — {0})', why) : ''),
      });
      continue;
    }

    const preferred = [req?.versionId, ...cons.map((c) => c.versionId)].filter(Boolean) as string[];
    const pick = candidates.find((v) => preferred.includes(v.versionId)) ?? candidates.find((v) => !v.optional) ?? candidates[0];
    if (cur?.version.versionId === pick.versionId) continue;

    if (cur?.installed && !req && !input.allowUpdates) {
      issue({
        severity: 'error',
        code: 'version-mismatch',
        subject: key,
        related: cons.map((c) => c.from).filter((f) => f !== 'user'),
        message: t('Нужна другая версия «{0}» ({1} → {2}). Разрешите обновление зависимостей.', cur.installed.title, cur.installed.version, pick.version),
      });
      continue;
    }

    if (cur) dropConstraintsFrom(key);
    selected.set(key, { version: pick, installed: cur?.installed });
    enqueueDeps(key, pick);
  }

  // Drop picks nothing reaches any more (left behind when a version changed).
  const reach = new Set<string>();
  const walk = (k: string) => {
    if (reach.has(k)) return;
    reach.add(k);
    const p = selected.get(k);
    if (!p) return;
    for (const d of p.version.deps) {
      if (d.kind !== 'requires' && !(input.includeRecommended && d.kind === 'recommends')) continue;
      const dk = keyOf(d.ref);
      walk(selected.has(dk) ? dk : providedBy(dk) ?? dk);
    }
  };
  for (const [k, p] of selected) if (p.installed || requested.has(k)) walk(k);
  for (const k of [...selected.keys()]) if (!reach.has(k)) selected.delete(k);

  // Conflicts inside the final solution.
  for (const [k, p] of selected) {
    for (const d of p.version.deps) {
      if (d.kind !== 'conflicts') continue;
      const ck = keyOf(d.ref);
      const other = selected.get(ck);
      if (!other || (d.range && !satisfies(other.version.version, d.range))) continue;
      const a = names.get(k) ?? k;
      const b = names.get(ck) ?? ck;
      issue({
        severity: 'error',
        code: 'conflict',
        subject: k,
        related: [ck],
        message: t('«{0}» несовместим с «{1}».', a, b),
        fix: other.installed ? { kind: 'disable', label: t('Выключить «{0}»', b), key: ck } : undefined,
      });
    }
  }

  // Recommended deps that were not pulled in.
  if (!input.includeRecommended) {
    for (const [k, p] of selected) {
      if (p.installed && !requested.has(k)) continue;
      for (const d of p.version.deps) {
        if (d.kind !== 'recommends') continue;
        const dk = keyOf(d.ref);
        if (selected.has(dk) || providedBy(dk)) continue;
        issue({
          severity: 'info',
          code: 'recommended',
          subject: k,
          related: [dk],
          message: t('«{0}» рекомендует «{1}».', names.get(k) ?? k, d.name ?? names.get(dk) ?? d.ref.projectId),
          fix: { kind: 'install', label: t('Добавить'), ref: d.ref, versionId: d.versionId },
        });
      }
    }
  }

  const fresh = [...selected].filter(([, p]) => !p.installed || p.installed.versionId !== p.version.versionId);
  // names for what is installed and for what the issues talk about
  const mentioned = [...new Set(issues.flatMap((i) => [i.subject, ...i.related]))].filter((k) => !names.has(k) && !k.startsWith('collection:') && k.includes(':') && !selected.has(k));
  const meta = await provider.meta([...fresh.map(([, p]) => p.version.ref), ...mentioned.map(refFromKey)]).catch(() => new Map<string, ProjectMeta>());
  for (const [k, m] of meta) names.set(k, m.title);

  const requiredByOf = (k: string) =>
    [...new Set((constraints.get(k) ?? []).map((c) => c.from))].filter((f) => f !== 'user' && (selected.has(f) || f.startsWith('collection:')));

  const install: PlanItem[] = [];
  const update: PlanItem[] = [];
  for (const [k, p] of fresh) {
    const m = meta.get(k);
    const item: PlanItem = {
      key: k,
      version: p.version,
      title: m?.title ?? names.get(k) ?? p.version.ref.projectId,
      iconUrl: m?.iconUrl ?? p.installed?.iconUrl,
      author: m?.author ?? p.installed?.author,
      reason: requested.has(k) ? input.reason : 'dependency',
      requiredBy: requiredByOf(k),
    };
    if (p.installed) update.push({ ...item, reason: p.installed.reason, fromVersion: p.installed.version });
    else install.push(item);
  }
  // issues may mention keys before titles were known
  for (const i of issues) for (const [k, n] of names) i.message = i.message.replaceAll(`«${k}»`, `«${n}»`);

  const keep = [...selected].filter(([, p]) => p.installed && p.installed.versionId === p.version.versionId).map(([k]) => k);
  return {
    id: planId,
    profileId: profile.id,
    install,
    update,
    keep,
    issues,
    ok: !issues.some((i) => i.severity === 'error'),
    collectionIds: [],
    label: input.label,
  };
}

function refFromKey(key: string): ModRef {
  const i = key.indexOf(':');
  return { source: key.slice(0, i) as ModRef['source'], projectId: key.slice(i + 1) };
}

function ctxLabel(ctx: GameContext): string {
  const parts = [ctx.gameVersion, ctx.loader].filter(Boolean);
  return parts.length ? parts.join(' + ') : t('этой игры');
}
