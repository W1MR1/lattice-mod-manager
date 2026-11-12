// Deploy/load order: dependencies first, then explicit before/after rules.
// Later entries overwrite files of earlier ones when deploying.
//
// Mods often point at each other ("works better with"), so links between mods
// may form loops. A loop of links alone is not a problem — it only means there
// is no single right order, and one is picked. A loop is reported only when a
// before/after rule the user (or a collection) set takes part in it: then two
// instructions really contradict each other.
import type { InstalledMod, OrderRule } from '../../shared/types';

export interface OrderResult {
  order: string[];
  /** groups of mods whose order rules contradict each other */
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

/** How binding an "A goes before B" edge is: a rule, a requirement, or a mere suggestion. */
const RANK = { soft: 0, dep: 1, rule: 2 } as const;
type EdgeKind = keyof typeof RANK;

export function computeOrder(mods: InstalledMod[], rules: OrderRule[]): OrderResult {
  const enabled = mods.filter((m) => m.enabled);
  const keys = new Set(enabled.map((m) => m.key));
  const providers = providerIndex(enabled);
  const out = new Map<string, Map<string, EdgeKind>>();
  const inc = new Map<string, Map<string, EdgeKind>>();
  for (const k of keys) {
    out.set(k, new Map());
    inc.set(k, new Map());
  }
  const edge = (from: string, to: string, kind: EdgeKind) => {
    if (from === to || !keys.has(from) || !keys.has(to)) return;
    const cur = out.get(from)!.get(to);
    if (cur !== undefined && RANK[cur] >= RANK[kind]) return;
    out.get(from)!.set(to, kind);
    inc.get(to)!.set(from, kind);
  };

  for (const m of enabled) {
    for (const d of m.deps) {
      if (d.kind !== 'requires' && d.kind !== 'recommends' && d.kind !== 'optional') continue;
      const depKey = `${d.ref.source}:${d.ref.projectId}`;
      for (const p of providers.get(depKey) ?? []) edge(p.key, m.key, d.kind === 'requires' ? 'dep' : 'soft');
    }
  }
  for (const r of rules) {
    if (r.kind === 'before') edge(r.subject, r.other, 'rule');
    else edge(r.other, r.subject, 'rule');
  }

  const title = new Map(enabled.map((m) => [m.key, m.title.toLowerCase()]));
  const byTitle = (a: string, b: string) => (title.get(a)! < title.get(b)! ? -1 : title.get(a)! > title.get(b)! ? 1 : a.localeCompare(b));

  // Kahn's algorithm with a sorted ready list for a stable, readable order.
  const left = new Map<string, Set<string>>([...keys].map((k) => [k, new Set(inc.get(k)!.keys())]));
  const done = new Set<string>();
  const ready = [...keys].filter((k) => left.get(k)!.size === 0).sort(byTitle);
  const order: string[] = [];
  let cycles: string[][] | null = null;
  const take = (k: string) => {
    order.push(k);
    done.add(k);
    for (const n of out.get(k)!.keys()) {
      const l = left.get(n)!;
      l.delete(k);
      if (l.size === 0 && !done.has(n) && !ready.includes(n)) {
        ready.push(n);
        ready.sort(byTitle);
      }
    }
  };
  while (order.length < keys.size) {
    if (ready.length) {
      take(ready.shift()!);
      continue;
    }
    // A loop. Report it once if rules are part of it, then let the mod go first
    // that is held back by the weakest links.
    const rest = [...keys].filter((k) => !done.has(k));
    if (!cycles) {
      cycles = [];
      for (const scc of tarjan(rest, out)) {
        if (scc.length < 2) continue;
        const inside = new Set(scc);
        const ruled = scc.some((a) => [...out.get(a)!].some(([b, kind]) => kind === 'rule' && inside.has(b)));
        if (ruled) cycles.push(scc.sort(byTitle));
      }
    }
    const weight = (k: string) => {
      let w = 0;
      for (const from of left.get(k)!) w += [1, 100, 10_000][RANK[inc.get(k)!.get(from)!]];
      return w;
    };
    const pick = rest.sort((a, b) => weight(a) - weight(b) || byTitle(a, b))[0];
    take(pick);
  }
  return { order, cycles: cycles ?? [] };
}

function tarjan(nodes: string[], out: Map<string, Map<string, EdgeKind>>): string[][] {
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
    for (const w of out.get(v)?.keys() ?? []) {
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
