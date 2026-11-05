import { keyOf, type Profile } from './types';

/**
 * The shortest way from a mod to one you installed yourself (or with a
 * collection), through the mods that require it: [mod, …, yours].
 */
export function whyInstalled(key: string, profile: Profile): string[] | null {
  const m = profile.mods[key];
  if (!m || m.reason !== 'dependency') return null;
  const needers = new Map<string, string[]>();
  for (const x of Object.values(profile.mods)) for (const d of x.deps) if (d.kind === 'requires') needers.set(keyOf(d.ref), [...(needers.get(keyOf(d.ref)) ?? []), x.key]);
  // a mod that provides another one (a drop-in replacement) is needed by whoever needs that one
  for (const x of Object.values(profile.mods)) for (const p of x.provides ?? []) needers.set(x.key, [...(needers.get(x.key) ?? []), ...(needers.get(p) ?? [])]);
  const from = new Map<string, string>([[key, '']]);
  const queue = [key];
  while (queue.length) {
    const k = queue.shift()!;
    if (k !== key && profile.mods[k]?.reason !== 'dependency') {
      const path = [k];
      for (let p = from.get(k)!; p; p = from.get(p)!) path.unshift(p);
      return path;
    }
    for (const n of needers.get(k) ?? []) if (!from.has(n) && profile.mods[n]?.enabled) {
      from.set(n, k);
      queue.push(n);
    }
  }
  return null;
}
