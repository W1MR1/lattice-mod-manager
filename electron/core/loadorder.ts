// Deploy/load order: dependencies first, then explicit before/after rules.
// Later entries overwrite files of earlier ones when deploying.
import type { InstalledMod, OrderRule } from '../../shared/types';

export interface OrderResult {
  order: string[];
  cycles: string[][];
}

/** key -> enabled mods that satisfy it (the mod itself and anything that `provides` it) */
export function providerIndex(mods: InstalledMod[]): Map<string, InstalledMod[]> {
  const idx = new Map<string, InstalledMod[]>();
  const add = (k: string, m: InstalledMod) => {
    const list = idx.get(k);
    if (list) list.push(m);
    else idx.set(k, [m]);
  };
  for (const m of mods) {
    add(m.key, m);
    for (const p of m.provides ?? []) add(p, m);
  }
  return idx;
}

export function computeOrder(mods: InstalledMod[], rules: OrderRule[]): OrderResult {
  const enabled = mods.filter((m) => m.enabled);
  const keys = new Set(enabled.map((m) => m.key));
  const providers = providerIndex(enabled);
  const out = new Map<string, Set<string>>();
  const indeg = new Map<string, number>();
  for (const k of keys) {
    out.set(k, new Set());
    indeg.set(k, 0);
  }
  const edge = (from: string, to: string) => {
    if (from === to || !keys.has(from) || !keys.has(to)) return;
    const s = out.get(from)!;
    if (s.has(to)) return;
    s.add(to);
    indeg.set(to, indeg.get(to)! + 1);
  };

  for (const m of enabled) {
    for (const d of m.deps) {
      if (d.kind !== 'requires' && d.kind !== 'recommends' && d.kind !== 'optional') continue;
      const depKey = `${d.ref.source}:${d.ref.projectId}`;
      for (const p of providers.get(depKey) ?? []) edge(p.key, m.key);
    }
  }
  for (const r of rules) {
    if (r.kind === 'before') edge(r.subject, r.other);
    else edge(r.other, r.subject);
  }

  const title = new Map(enabled.map((m) => [m.key, m.title.toLowerCase()]));
  const byTitle = (a: string, b: string) => (title.get(a)! < title.get(b)! ? -1 : title.get(a)! > title.get(b)! ? 1 : a.localeCompare(b));

  // Kahn's algorithm with a sorted ready list for a stable, readable order.
  const ready = [...keys].filter((k) => indeg.get(k) === 0).sort(byTitle);
  const order: string[] = [];
  while (ready.length) {
    const k = ready.shift()!;
    order.push(k);
    for (const n of out.get(k)!) {
      indeg.set(n, indeg.get(n)! - 1);
      if (indeg.get(n) === 0) {
        ready.push(n);
        ready.sort(byTitle);
      }
    }
  }

  const cycles: string[][] = [];
  if (order.length < keys.size) {
    const rest = [...keys].filter((k) => !order.includes(k));
    for (const scc of tarjan(rest, out)) if (scc.length > 1) cycles.push(scc.sort(byTitle));
    order.push(...rest.sort(byTitle));
  }
  return { order, cycles };
}

function tarjan(nodes: string[], out: Map<string, Set<string>>): string[][] {
  const inSet = new Set(nodes);
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const result: string[][] = [];

  const strong = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of out.get(v) ?? []) {
      if (!inSet.has(w)) continue;
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      result.push(scc);
    }
  };
  for (const n of nodes) if (!idx.has(n)) strong(n);
  return result;
}
