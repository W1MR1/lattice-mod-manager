import { useMemo, useState } from 'react';
import { ArrowUpRight, Network } from 'lucide-react';
import type { CompatReport, Profile } from '../../shared/types';
import { keyOf } from '../../shared/types';
import { plural } from '../format';
import { useActive, useUI } from '../store';
import { Empty, HealthRing, SevIcon } from '../components/ui';
import { runFix } from './Mods';

const W = 196;
const H = 38;
const GAP_X = 300;
const GAP_Y = 52;
const PAD = 28;

interface GNode {
  key: string;
  title: string;
  version: string;
  ghost: boolean;
  enabled: boolean;
  tone: 'ok' | 'warn' | 'err' | 'muted';
  x: number;
  y: number;
}

interface GEdge {
  from: string; // dependency (drawn on the left)
  to: string; // dependent
  kind: 'req' | 'rec' | 'conflict';
}

function layout(profile: Profile, report: CompatReport | null) {
  const mods = Object.values(profile.mods);
  const keys = new Set(mods.map((m) => m.key));
  const providers = new Map<string, string>();
  for (const m of mods) for (const p of m.provides ?? []) providers.set(p, m.key);
  const ghosts = new Map<string, string>();
  const edges: GEdge[] = [];
  for (const m of mods) {
    for (const d of m.deps) {
      if (d.kind === 'embedded') continue;
      const k = keyOf(d.ref);
      const target = keys.has(k) ? k : providers.get(k);
      if (d.kind === 'conflicts') {
        if (target) edges.push({ from: target, to: m.key, kind: 'conflict' });
        continue;
      }
      if (target) edges.push({ from: target, to: m.key, kind: d.kind === 'requires' ? 'req' : 'rec' });
      else if (d.kind === 'requires') {
        ghosts.set(k, d.name ?? d.ref.projectId);
        edges.push({ from: k, to: m.key, kind: 'req' });
      }
    }
  }

  const deps = new Map<string, string[]>();
  for (const e of edges) if (e.kind !== 'conflict') deps.set(e.to, [...(deps.get(e.to) ?? []), e.from]);
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (k: string): number => {
    if (layer.has(k)) return layer.get(k)!;
    if (visiting.has(k)) return 0;
    visiting.add(k);
    const ds = deps.get(k) ?? [];
    const d = ds.length ? 1 + Math.max(...ds.map(depth)) : 0;
    visiting.delete(k);
    layer.set(k, d);
    return d;
  };
  const all = [...keys, ...ghosts.keys()];
  all.forEach(depth);

  const titleOf = (k: string) => profile.mods[k]?.title ?? ghosts.get(k) ?? k;
  const columns: string[][] = [];
  for (const k of all) (columns[layer.get(k)!] ??= []).push(k);
  for (const col of columns) col?.sort((a, b) => titleOf(a).localeCompare(titleOf(b)));
  // Two barycentre sweeps reduce edge crossings.
  for (let pass = 0; pass < 2; pass++) {
    const pos = new Map<string, number>();
    columns.forEach((col) => col?.forEach((k, i) => pos.set(k, i)));
    for (let c = 1; c < columns.length; c++) {
      const col = columns[c];
      if (!col) continue;
      const bary = new Map(col.map((k) => [k, avg((deps.get(k) ?? []).map((d) => pos.get(d) ?? 0)) ?? pos.get(k)!]));
      col.sort((a, b) => bary.get(a)! - bary.get(b)!);
      col.forEach((k, i) => pos.set(k, i));
    }
  }

  const issueTone = new Map<string, GNode['tone']>();
  for (const i of report?.issues ?? []) {
    if (i.severity === 'info') continue;
    const t = i.severity === 'error' ? 'err' : 'warn';
    if (issueTone.get(i.subject) !== 'err') issueTone.set(i.subject, t);
  }
  const nodes: GNode[] = [];
  columns.forEach((col, c) =>
    col?.forEach((k, i) => {
      const m = profile.mods[k];
      nodes.push({
        key: k,
        title: titleOf(k),
        version: m?.version ?? 'не установлен',
        ghost: !m,
        enabled: m?.enabled ?? false,
        tone: !m ? 'err' : !m.enabled ? 'muted' : (issueTone.get(k) ?? 'ok'),
        x: PAD + c * GAP_X,
        y: PAD + i * GAP_Y,
      });
    }),
  );
  const width = PAD * 2 + Math.max(0, columns.length - 1) * GAP_X + W;
  const height = PAD * 2 + Math.max(1, ...columns.map((c) => c?.length ?? 0)) * GAP_Y;
  return { nodes, edges, width, height };
}

function avg(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
}

const GLYPH = { ok: '✓', warn: '!', err: '×', muted: '–' };
const TONE_VAR = { ok: 'var(--ok)', warn: 'var(--warn)', err: 'var(--err)', muted: 'var(--text-3)' };

export function Graph() {
  const { profile } = useActive();
  const report = useUI((s) => s.report);
  const select = useUI((s) => s.select);
  const go = useUI((s) => s.go);
  const [hover, setHover] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const g = useMemo(() => (profile ? layout(profile, report) : null), [profile, report]);
  if (!profile || !g) return null;
  if (g.nodes.length === 0)
    return (
      <div className="content">
        <Empty icon={<Network size={32} color="var(--text-3)" />} title="Граф пуст" text="Установите моды — здесь появятся их связи: кто от кого зависит и кто с кем конфликтует." />
      </div>
    );

  const pos = new Map(g.nodes.map((n) => [n.key, n]));
  const focus = hover ?? picked;
  const near = new Set<string>(focus ? [focus, ...g.edges.filter((e) => e.from === focus || e.to === focus).flatMap((e) => [e.from, e.to])] : []);
  const issues = report?.issues ?? [];
  const pickedNode = picked ? pos.get(picked) : undefined;
  const pickedIssues = picked ? issues.filter((i) => i.subject === picked || i.related.includes(picked)) : [];

  return (
    <div className="content">
      <div className="screen">
        <div className="toolbar">
          <div className="legend">
            <span>
              <i /> требует
            </span>
            <span>
              <i className="rec" /> рекомендует
            </span>
            <span>
              <i className="conflict" /> конфликтует
            </span>
            <span>Пунктирная рамка — зависимость не установлена</span>
          </div>
          <span className="grow" />
          <span className="faint">Зависимости слева, зависимые справа</span>
        </div>
        <div className="graph-wrap">
          <svg width={g.width} height={g.height} role="img" aria-label={`Граф связей: ${g.nodes.length} узлов`}>
            {g.edges.map((e, i) => {
              const a = pos.get(e.from);
              const b = pos.get(e.to);
              if (!a || !b) return null;
              const sameCol = a.x === b.x;
              const x1 = sameCol ? a.x + W : a.x + W;
              const y1 = a.y + H / 2;
              const x2 = sameCol ? b.x + W : b.x;
              const y2 = b.y + H / 2;
              const d = sameCol ? `M${x1} ${y1} C${x1 + 60} ${y1}, ${x2 + 60} ${y2}, ${x2} ${y2}` : `M${x1} ${y1} C${x1 + 70} ${y1}, ${x2 - 70} ${y2}, ${x2} ${y2}`;
              const hl = focus && (e.from === focus || e.to === focus);
              return <path key={i} d={d} className={`graph-edge ${e.kind === 'rec' ? 'rec' : e.kind === 'conflict' ? 'conflict' : ''} ${hl && e.kind !== 'conflict' ? 'hl' : ''} ${focus && !hl ? 'graph-dim' : ''}`} />;
            })}
            {g.nodes.map((n) => (
              <g
                key={n.key}
                className={`graph-node ${n.ghost ? 'ghost' : ''} ${!n.enabled && !n.ghost ? 'off' : ''} ${picked === n.key ? 'sel' : ''} ${focus && !near.has(n.key) ? 'graph-dim' : ''}`}
                transform={`translate(${n.x} ${n.y})`}
                onMouseEnter={() => setHover(n.key)}
                onMouseLeave={() => setHover(null)}
                onClick={() => setPicked(n.key === picked ? null : n.key)}
                role="button"
                aria-label={`${n.title}, ${n.version}`}
              >
                <rect width={W} height={H} rx={8} />
                <circle cx={16} cy={H / 2} r={7} fill={TONE_VAR[n.tone]} />
                <text x={16} y={H / 2 + 0.5} textAnchor="middle" dominantBaseline="central" style={{ fill: 'var(--bg-1)', fontSize: 10, fontWeight: 800 }}>
                  {GLYPH[n.tone]}
                </text>
                <text x={30} y={15}>
                  {n.title.length > 24 ? `${n.title.slice(0, 23)}…` : n.title}
                </text>
                <text x={30} y={29} className="sub">
                  {n.version.length > 28 ? `${n.version.slice(0, 27)}…` : n.version}
                </text>
              </g>
            ))}
          </svg>
        </div>
      </div>
      <aside className="graph-side" aria-label="Совместимость">
        {report && (
          <div className="row">
            <HealthRing score={report.score} size={52} />
            <div className="col" style={{ gap: 0 }}>
              <b style={{ fontSize: 'var(--fs-lg)' }}>{report.errors === 0 && report.warnings === 0 ? 'Все связи сходятся' : 'Есть что поправить'}</b>
              <span className="muted">
                {plural(report.errors, 'ошибка', 'ошибки', 'ошибок')} · {plural(report.warnings, 'предупреждение', 'предупреждения', 'предупреждений')}
              </span>
            </div>
          </div>
        )}
        {pickedNode && (
          <div className="card card-pad col">
            <b>{pickedNode.title}</b>
            <span className="mono muted">{pickedNode.version}</span>
            {pickedIssues.length === 0 && <span className="faint">Проблем нет.</span>}
            {!pickedNode.ghost && (
              <button
                className="btn sm"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => {
                  select(pickedNode.key);
                  go('mods');
                }}
              >
                Открыть в модах <ArrowUpRight size={13} />
              </button>
            )}
          </div>
        )}
        <span className="label">{picked ? 'Проблемы узла' : 'Все проблемы'}</span>
        {(picked ? pickedIssues : issues).length === 0 && <span className="faint">Список пуст.</span>}
        {(picked ? pickedIssues : issues).map((i) => (
          <div key={i.id} className="card" style={{ padding: 12, display: 'flex', gap: 10 }}>
            <SevIcon s={i.severity} />
            <div className="col grow" style={{ gap: 6 }}>
              <span style={{ fontSize: 'var(--fs-sm)', lineHeight: 'var(--lh-sm)', userSelect: 'text' }}>{i.message}</span>
              {i.fix && (
                <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => runFix(profile.id, i.fix!)}>
                  {i.fix.label}
                </button>
              )}
            </div>
          </div>
        ))}
      </aside>
    </div>
  );
}
