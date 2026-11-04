// Links between installed mods: who requires whom, and which automatically
// installed mods nothing needs any more.
import type { Profile } from '../../shared/types';
import { keyOf } from '../../shared/types';
import { providerIndex } from './loadorder';

/** Rebuilds `requiredBy` from the actual dependency declarations and applied collections. */
export function recomputeLinks(profile: Profile) {
  const mods = Object.values(profile.mods);
  const providers = providerIndex(mods);
  const requirers = new Map<string, Set<string>>();
  for (const m of mods) {
    for (const d of m.deps) {
      if (d.kind !== 'requires') continue;
      for (const p of providers.get(keyOf(d.ref)) ?? []) {
        if (p.key === m.key) continue;
        if (!requirers.has(p.key)) requirers.set(p.key, new Set());
        requirers.get(p.key)!.add(m.key);
      }
    }
  }
  for (const m of mods) {
    const markers = m.requiredBy.filter((r) => r.startsWith('collection:') && profile.collections.includes(r.slice('collection:'.length)));
    m.requiredBy = [...new Set(markers), ...(requirers.get(m.key) ?? [])];
  }
}

/** Removes mods that were pulled in automatically and are no longer needed by anything. */
export function collectOrphans(profile: Profile): string[] {
  const removed: string[] = [];
  for (;;) {
    recomputeLinks(profile);
    const orphan = Object.values(profile.mods).filter((m) => m.reason !== 'explicit' && m.requiredBy.length === 0);
    if (orphan.length === 0) return removed;
    for (const m of orphan) {
      delete profile.mods[m.key];
      removed.push(m.key);
    }
  }
}
