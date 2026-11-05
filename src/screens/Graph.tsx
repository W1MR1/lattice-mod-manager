import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, LocateFixed, Maximize, Network, Search, ZoomIn, ZoomOut } from 'lucide-react';
import type { CompatReport, Profile } from '../../shared/types';
import { keyOf } from '../../shared/types';
import { plural } from '../format';
import { useActive, useUI } from '../store';
import { Empty, HealthRing, SevIcon } from '../components/ui';
import { runFix } from './Mods';
import { t } from '../../shared/i18n';

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
        version: m?.version ?? t('не установлен'),
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
  const [only, setOnly] = useState(false);
  const [query, setQuery] = useState('');
  const g = useMemo(() => (profile ? layout(profile, report) : null), [profile, report]);

  // ---- view: pan (x, y) and zoom (k) of the graph inside its frame
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState<{ x: number; y: number; k: number } | null>(null);
  const drag = useRef<{ sx: number; sy: number; x: number; y: number; moved: boolean } | null>(null);
  const clamp = (k: number) => Math.min(3, Math.max(0.08, k));

  const fit = useCallback(() => {
    if (!g) return;
    const k = clamp(Math.min(1, (size.w - 32) / g.width, (size.h - 32) / g.height));
    setView({ k, x: (size.w - g.width * k) / 2, y: Math.max(12, (size.h - g.height * k) / 2) });
  }, [g, size.w, size.h]);

  const zoomAt = (factor: number, cx = size.w / 2, cy = size.h / 2) =>
    setView((v) => {
      if (!v) return v;
      const k = clamp(v.k * factor);
      const f = k / v.k;
      return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
    });

  const centerOn = (key: string) => {
    const n = g?.nodes.find((x) => x.key === key);
    if (!n) return;
    setView((v) => {
      const k = Math.max(v?.k ?? 1, 0.8);
      return { k, x: size.w / 2 - (n.x + W / 2) * k, y: size.h / 2 - (n.y + H / 2) * k };
    });
  };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    // wheel zooms around the cursor; Shift+wheel and two-finger swipes move the view
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.shiftKey || (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
        setView((v) => (v ? { ...v, x: v.x - (e.deltaX || e.deltaY), y: e.shiftKey ? v.y : v.y - e.deltaY } : v));
        return;
      }
      zoomAtRef.current(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', onWheel);
    };
  }, [(g?.nodes.length ?? 0) > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const zoomAtRef = useRef(zoomAt);
  zoomAtRef.current = zoomAt;

  // a new profile or a first look: the whole graph in view
  const nodeCount = g?.nodes.length ?? 0;
  useEffect(() => {
    if (nodeCount && size.w > 100) fit();
  }, [profile?.id, nodeCount > 0, size.w > 100]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!profile || !g) return null;
  if (g.nodes.length === 0)
    return (
      <div className="content">
        <Empty icon={<Network size={32} color="var(--text-3)" />} title={t("Граф пуст")} text={t("Установите моды — здесь появятся их связи: кто от кого зависит и кто с кем конфликтует.")} />
      </div>
    );

  const pos = new Map(g.nodes.map((n) => [n.key, n]));
  const focus = hover ?? picked;
  const near = new Set<string>(focus ? [focus, ...g.edges.filter((e) => e.from === focus || e.to === focus).flatMap((e) => [e.from, e.to])] : []);
  // "only its links": everything the picked mod needs and everything that needs it, all the way
  const chain = new Set<string>();
  if (only && picked) {
    const walk = (k: string, dir: 'up' | 'down') => {
      for (const e of g.edges) {
        const next = dir === 'up' ? (e.to === k ? e.from : null) : e.from === k ? e.to : null;
        if (next && !chain.has(next)) {
          chain.add(next);
          walk(next, dir);
        }
      }
    };
    chain.add(picked);
    walk(picked, 'up');
    walk(picked, 'down');
  }
  const hidden = (k: string) => only && !!picked && !chain.has(k);
  const v = view ?? { x: 0, y: 0, k: 1 };
  const find = (text: string) => {
    const q = text.trim().toLowerCase();
    if (!q) return;
    const hit = g.nodes.find((n) => n.title.toLowerCase().includes(q));
    if (hit) {
      setPicked(hit.key);
      centerOn(hit.key);
    }
  };
  const issues = report?.issues ?? [];
  const pickedNode = picked ? pos.get(picked) : undefined;
  const pickedIssues = picked ? issues.filter((i) => i.subject === picked || i.related.includes(picked)) : [];

  return (
    <div className="content">
      <div className="screen">
        <div className="toolbar">
          <div className="legend">
            <span>
              <i /> {t('требует')}
            </span>
            <span>
              <i className="rec" /> {t('рекомендует')}
            </span>
            <span>
              <i className="conflict" /> {t('конфликтует')}
            </span>
            <span>{t('Пунктирная рамка — зависимость не установлена')}</span>
          </div>
          <span className="grow" />
          <div className="search" style={{ width: 220 }}>
            <Search size={15} />
            <input
              className="input"
              placeholder={t('Найти мод на графе')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && find(query)}
              aria-label={t('Найти мод на графе')}
            />
          </div>
          <label className="row muted" title={t('Оставить на графе только то, что нужно выбранному моду, и то, что нужно ему самому')}>
            <input type="checkbox" checked={only} disabled={!picked} onChange={(e) => setOnly(e.target.checked)} />
            {t('Только связи выбранного')}
          </label>
        </div>
        <div
          className="graph-wrap"
          ref={wrapRef}
          tabIndex={0}
          onPointerDown={(e) => {
            if (e.button !== 0 && e.button !== 1) return;
            drag.current = { sx: e.clientX, sy: e.clientY, x: v.x, y: v.y, moved: false };
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const dx = e.clientX - d.sx;
            const dy = e.clientY - d.sy;
            if (!d.moved && Math.hypot(dx, dy) < 4) return;
            d.moved = true;
            setView({ ...v, x: d.x + dx, y: d.y + dy });
          }}
          onPointerUp={() => {
            // a drag that moved is not a click on the node under it
            setTimeout(() => (drag.current = null), 0);
          }}
          onKeyDown={(e) => {
            const step = 80;
            if (e.key === '+' || e.key === '=') zoomAt(1.2);
            else if (e.key === '-') zoomAt(1 / 1.2);
            else if (e.key === '0') fit();
            else if (e.key === 'ArrowLeft') setView({ ...v, x: v.x + step });
            else if (e.key === 'ArrowRight') setView({ ...v, x: v.x - step });
            else if (e.key === 'ArrowUp') setView({ ...v, y: v.y + step });
            else if (e.key === 'ArrowDown') setView({ ...v, y: v.y - step });
            else return;
            e.preventDefault();
          }}
        >
          <svg width="100%" height="100%" role="img" aria-label={t('Граф связей: {0} узлов', g.nodes.length)}>
            <g transform={`translate(${v.x} ${v.y}) scale(${v.k})`}>
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
              if (hidden(e.from) || hidden(e.to)) return null;
              return <path key={i} d={d} className={`graph-edge ${e.kind === 'rec' ? 'rec' : e.kind === 'conflict' ? 'conflict' : ''} ${hl && e.kind !== 'conflict' ? 'hl' : ''} ${focus && !hl ? 'graph-dim' : ''}`} />;
            })}
            {g.nodes.filter((n) => !hidden(n.key)).map((n) => (
              <g
                key={n.key}
                className={`graph-node ${n.ghost ? 'ghost' : ''} ${!n.enabled && !n.ghost ? 'off' : ''} ${picked === n.key ? 'sel' : ''} ${focus && !near.has(n.key) ? 'graph-dim' : ''}`}
                transform={`translate(${n.x} ${n.y})`}
                onMouseEnter={() => setHover(n.key)}
                onMouseLeave={() => setHover(null)}
                onClick={() => {
                  if (drag.current?.moved) return;
                  setPicked(n.key === picked ? null : n.key);
                }}
                onDoubleClick={() => {
                  if (n.ghost) return;
                  select(n.key);
                  go('mods');
                }}
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
            </g>
          </svg>
          <Minimap g={g} view={v} size={size} picked={picked} onMove={(cx, cy) => setView({ ...v, x: size.w / 2 - cx * v.k, y: size.h / 2 - cy * v.k })} />
          <div className="graph-controls" onPointerDown={(e) => e.stopPropagation()}>
            <button className="btn sm icon" title={t('Отдалить (−)')} aria-label={t('Отдалить (−)')} onClick={() => zoomAt(1 / 1.25)}>
              <ZoomOut size={15} />
            </button>
            <button className="btn sm mono" title={t('Масштаб 100%')} onClick={() => zoomAt(1 / v.k)} style={{ minWidth: 56 }}>
              {Math.round(v.k * 100)}%
            </button>
            <button className="btn sm icon" title={t('Приблизить (+)')} aria-label={t('Приблизить (+)')} onClick={() => zoomAt(1.25)}>
              <ZoomIn size={15} />
            </button>
            <button className="btn sm icon" title={t('Весь граф (0)')} aria-label={t('Весь граф (0)')} onClick={fit}>
              <Maximize size={15} />
            </button>
            <button className="btn sm icon" title={t('К выбранному моду')} aria-label={t('К выбранному моду')} disabled={!picked} onClick={() => picked && centerOn(picked)}>
              <LocateFixed size={15} />
            </button>
          </div>
          <div className="graph-hint faint">{t('Колесо — масштаб, перетаскивание — перемещение, двойной щелчок — открыть мод')}</div>
        </div>
      </div>
      <aside className="graph-side" aria-label={t("Совместимость")}>
        {report && (
          <div className="row">
            <HealthRing score={report.score} size={52} />
            <div className="col" style={{ gap: 0 }}>
              <b style={{ fontSize: 'var(--fs-lg)' }}>{report.errors === 0 && report.warnings === 0 ? t('Все связи сходятся') : t('Есть что поправить')}</b>
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
            {pickedIssues.length === 0 && <span className="faint">{t('Проблем нет.')}</span>}
            {!pickedNode.ghost && (
              <button
                className="btn sm"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => {
                  select(pickedNode.key);
                  go('mods');
                }}
              >
                {t('Открыть в модах')} <ArrowUpRight size={13} />
              </button>
            )}
          </div>
        )}
        <span className="label">{picked ? t('Проблемы узла') : t('Все проблемы')}</span>
        {(picked ? pickedIssues : issues).length === 0 && <span className="faint">{t('Список пуст.')}</span>}
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

/** The whole graph in small, with the visible part framed; a click or drag moves the view there. */
function Minimap({ g, view, size, picked, onMove }: { g: { nodes: GNode[]; width: number; height: number }; view: { x: number; y: number; k: number }; size: { w: number; h: number }; picked: string | null; onMove: (cx: number, cy: number) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const down = useRef(false);
  const MW = 180;
  const MH = 120;
  const scale = Math.min(MW / g.width, MH / g.height);
  const ox = (MW - g.width * scale) / 2;
  const oy = (MH - g.height * scale) / 2;
  const toContent = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return [(e.clientX - r.left - ox) / scale, (e.clientY - r.top - oy) / scale] as const;
  };
  return (
    <svg
      ref={ref}
      className="graph-minimap"
      width={MW}
      height={MH}
      onPointerDown={(e) => {
        e.stopPropagation();
        down.current = true;
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        onMove(...toContent(e));
      }}
      onPointerMove={(e) => down.current && onMove(...toContent(e))}
      onPointerUp={() => (down.current = false)}
      aria-hidden
    >
      <g transform={`translate(${ox} ${oy}) scale(${scale})`}>
        {g.nodes.map((n) => (
          <rect key={n.key} x={n.x} y={n.y} width={W} height={H} rx={6} fill={n.key === picked ? 'var(--accent)' : TONE_VAR[n.tone]} opacity={n.key === picked ? 1 : 0.55} />
        ))}
        <rect className="graph-minimap-view" x={-view.x / view.k} y={-view.y / view.k} width={size.w / view.k} height={size.h / view.k} />
      </g>
    </svg>
  );
}
