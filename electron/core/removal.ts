// Removing mods with the user's choice of what goes along: the mods they pulled
// in as dependencies, and the mods that need them.
import type { Profile } from '../../shared/types';
import { keyOf } from '../../shared/types';
import { providerIndex } from './loadorder';
import { collectOrphans, recomputeLinks } from './links';

export interface RemovalOptions {
  /** also remove dependencies nothing else needs; otherwise they stay as the user's own mods */
  withDeps: boolean;
  /** also remove enabled mods that would stop working; otherwise they block the removal */
  withDependents: boolean;
}

export interface RemovalPlan {
  /** the mods asked for, plus their dependents when chosen */
  remove: string[];
  /** enabled mods that need something being removed */
  dependents: string[];
  /** dependencies left without a user, removed when `withDeps` */
  deps: string[];
}

/** Enabled mods outside `gone` that lose their only provider of a requirement. */
function dependentsOf(p: Profile, gone: Set<string>): string[] {
  const all = Object.values(p.mods);
  const before = providerIndex(all.filter((m) => m.enabled));
  const after = providerIndex(all.filter((m) => m.enabled && !gone.has(m.key)));
  return all
    .filter((m) => m.enabled && !gone.has(m.key))
    .filter((m) =>
      m.deps.some((d) => {
        if (d.kind !== 'requires') return false;
        const k = keyOf(d.ref);
        const hadGone = (before.get(k) ?? []).some((x) => gone.has(x.key));
        const left = (after.get(k) ?? []).filter((x) => x.key !== m.key);
        return hadGone && left.length === 0;
      }),
    )
    .map((m) => m.key);
}

export function planRemoval(p: Profile, keys: string[], opts: RemovalOptions): RemovalPlan {
  const gone = new Set(keys.filter((k) => p.mods[k]));
  const dependents = new Set<string>();
  for (;;) {
    const next = dependentsOf(p, gone).filter((k) => !dependents.has(k));
    if (next.length === 0) break;
    next.forEach((k) => dependents.add(k));
    if (!opts.withDependents) break;
    next.forEach((k) => gone.add(k));
  }
  // what would be left without a user once these are gone
  const trial: Profile = structuredClone(p);
  for (const k of gone) delete trial.mods[k];
  const deps = collectOrphans(trial);
  return { remove: [...gone], dependents: [...dependents], deps };
}

/** Applies a removal plan to the profile in place. Returns the keys removed. */
export function applyRemoval(p: Profile, plan: RemovalPlan, opts: RemovalOptions): string[] {
  const removed = [...plan.remove];
  for (const k of plan.remove) delete p.mods[k];
  if (opts.withDeps) {
    for (const k of plan.deps) delete p.mods[k];
    removed.push(...plan.deps);
  } else {
    // kept dependencies become the user's own, so later clean-ups leave them alone
    for (const k of plan.deps) if (p.mods[k]) p.mods[k].reason = 'explicit';
  }
  p.rules = p.rules.filter((r) => p.mods[r.subject] && p.mods[r.other]);
  recomputeLinks(p);
  return removed;
}
