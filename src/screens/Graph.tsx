import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, LocateFixed, Maximize, Network, Search, ZoomIn, ZoomOut } from 'lucide-react';
import type { CompatReport, Profile } from '../../shared/types';
import { keyOf } from '../../shared/types';
import { plural } from '../format';
import { useActive, useUI } from '../store';
import { Empty, HealthRing, SevIcon } from '../components/ui';
import { runFix } from './Mods';
import { t } from '../../shared/i18n';
import { whyInstalled } from '../../shared/why';

const W = 196;
const H = 38;
const GAP_X = 300;
const GAP_Y = 52;
const PAD = 28;
/** lanes of one layer stand closer than layers: no link runs between them */
const LANE_X = W + 26;
/** a layer taller than this wraps into lanes */
const WRAP_FROM = 14;
/** width to height the wrapped graph aims at: about the frame it is shown in */
const SHAPE = 1.6;

interface GNode {
  key: string;
  title: string;
  version: string;
  ghost: boolean;
  enabled: boolean;
  tone: 'ok' | 'warn' | 'err' | 'muted';
  /** why the node has its mark, in a sentence (the worst problem, or what the mark means) */
  reason: string;
  x: number;
  y: number;
}

interface GEdge {
  from: string; // dependency (drawn on the left)
  to: string; // dependent
  kind: 'req' | 'rec' | 'conflict';
}

function layout(profile: Profile, report: CompatReport | null, skip: Set<string>) {
  const mods = Object.values(profile.mods).filter((m) => !skip.has(m.key));
  const keys = new Set(mods.map((m) => m.key));
  const providers = new Map<string, string>();
  for (const m of Object.values(profile.mods)) for (const p of m.provides ?? []) providers.set(p, m.key);
  const ghosts = new Map<string, string>();
  const edges: GEdge[] = [];
  for (const m of mods) {
    for (const d of m.deps) {
      if (d.kind === 'embedded') continue;
      const k = keyOf(d.ref);
      if (skip.has(k) || skip.has(providers.get(k) ?? '')) continue; // a hidden library
      const target = keys.has(k) ? k : providers.get(k);
      if (d.kind === 'conflicts') {
        if (target) edges.push({ from: target, to: m.key, kind: 'conflict' });
        continue;
      }
      if (target) edges.push({ from: target, to: m.key, kind: d.kind === 'requires' ? 'req' : 'rec' });
      else if (d.kind === 'requires') {
        ghosts.set(k, d.name ?? report?.names?.[k] ?? d.ref.projectId);
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
  const issueText = new Map<string, string>();
  // a dependency that is not installed is as bad as the worst problem that names it
  const ghostTone = new Map<string, GNode['tone']>();
  for (const i of report?.issues ?? []) {
    const tone = i.severity === 'error' ? 'err' : i.severity === 'warning' ? 'warn' : 'muted';
    for (const r of i.related) if (ghosts.has(r) && (ghostTone.get(r) ?? 'muted') !== 'err' && tone !== 'muted') ghostTone.set(r, tone);
    if (i.severity === 'info') continue;
    if (issueTone.get(i.subject) !== 'err') {
      issueTone.set(i.subject, tone);
      issueText.set(i.subject, i.message);
    }
  }
  // A layer of sixty mods in one column makes a strip no window can show.
  // Long layers wrap into lanes; the lane height is the one that brings the
  // whole graph closest to the shape of the window.
  const sizes = columns.map((c) => c?.length ?? 0);
  const tallest = Math.max(1, ...sizes);
  const lanesAt = (rows: number) => sizes.map((n) => Math.max(1, Math.ceil(n / rows)));
  // lanes of a layer are filled evenly, so the graph is as tall as its fullest lane
  const rowsOf = (lanes: number[]) => Math.max(1, ...sizes.map((n, c) => Math.ceil(n / lanes[c])));
  const widthAt = (lanes: number[]) => PAD * 2 + lanes.reduce((a, n) => a + (n - 1) * LANE_X, 0) + Math.max(0, lanes.length - 1) * GAP_X + W;
  let rows = tallest;
  if (tallest > WRAP_FROM) {
    let best = Infinity;
    for (let r = 10; r <= tallest; r++) {
      const off = Math.abs(Math.log(widthAt(lanesAt(r)) / (PAD * 2 + rowsOf(lanesAt(r)) * GAP_Y) / SHAPE));
      if (off < best) {
        best = off;
        rows = r;
      }
    }
  }
  const lanes = lanesAt(rows);
  const nodes: GNode[] = [];
  let left = PAD;
  columns.forEach((col, c) => {
    // even lanes rather than a full one and a stub
    const per = Math.ceil((col?.length ?? 0) / lanes[c]) || 1;
    const x0 = left;
    left += (lanes[c] - 1) * LANE_X + GAP_X;
    col?.forEach((k, i) => {
      const m = profile.mods[k];
      const tone: GNode['tone'] = !m ? (ghostTone.get(k) ?? 'muted') : !m.enabled ? 'muted' : (issueTone.get(k) ?? 'ok');
      nodes.push({
        key: k,
        title: titleOf(k),
        version: m?.version ?? (tone === 'muted' ? t('не установлен, для запуска не нужен') : t('не установлен')),
        ghost: !m,
        enabled: m?.enabled ?? false,
        tone,
        reason: !m
          ? tone === 'muted'
            ? t('На него ссылается каталог, но для запуска он не нужен.')
            : t('Не установлен, а другой мод без него не заработает.')
          : !m.enabled
            ? t('Выключен: его файлов нет в игре.')
            : (issueText.get(k) ?? t('Включён, проблем не найдено.')),
        x: x0 + Math.floor(i / per) * LANE_X,
        y: PAD + (i % per) * GAP_Y,
      });
    });
  });
  const width = widthAt(lanes);
  const height = PAD * 2 + rowsOf(lanes) * GAP_Y;
  return { nodes, edges, width, height };
}

/** Everything the picked mod needs and everything that needs it, all the way. */
function chainOf(g: { edges: GEdge[] }, picked: string): Set<string> {
  const chain = new Set<string>([picked]);
  const walk = (k: string, dir: 'up' | 'down') => {
    for (const e of g.edges) {
      const next = dir === 'up' ? (e.to === k ? e.from : null) : e.from === k ? e.to : null;
      if (next && !chain.has(next)) {
        chain.add(next);
        walk(next, dir);
      }
    }
  };
  walk(picked, 'up');
  walk(picked, 'down');
  return chain;
}

interface SceneProps {
  g: { nodes: GNode[]; edges: GEdge[] };
  lod: 'full' | 'title' | 'dot';
  bigFont: number;
  bigChars: number;
  focus: string | null;
  picked: string | null;
  only: boolean;
  drag: React.MutableRefObject<{ moved: boolean } | null>;
  onPick: (k: string | null) => void;
  onHover: (k: string | null) => void;
  onOpen: (k: string) => void;
}

/**
 * Edges and nodes. Moving the view only changes the transform around them, so
 * this part is not redrawn while the graph is dragged — big graphs stay smooth.
 */
const Scene = memo(
  function Scene({ g, lod, bigFont, bigChars, focus, picked, only, drag, onPick, onHover, onOpen }: SceneProps) {
    const pos = useMemo(() => new Map(g.nodes.map((n) => [n.key, n])), [g]);
    const chain = useMemo(() => (only && picked ? chainOf(g, picked) : null), [g, only, picked]);
    const hidden = (k: string) => !!chain && !chain.has(k);
    const near = new Set<string>(focus ? [focus, ...g.edges.filter((e) => e.from === focus || e.to === focus).flatMap((e) => [e.from, e.to])] : []);
    return (
      <>
        {g.edges.map((e, i) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b || hidden(e.from) || hidden(e.to)) return null;
          const sameCol = a.x === b.x;
          const x1 = a.x + W;
          const y1 = a.y + H / 2;
          const x2 = sameCol ? b.x + W : b.x;
          const y2 = b.y + H / 2;
          const d = sameCol ? `M${x1} ${y1} C${x1 + 60} ${y1}, ${x2 + 60} ${y2}, ${x2} ${y2}` : `M${x1} ${y1} C${x1 + 70} ${y1}, ${x2 - 70} ${y2}, ${x2} ${y2}`;
          const hl = focus && (e.from === focus || e.to === focus);
          return <path key={i} d={d} className={`graph-edge ${e.kind === 'rec' ? 'rec' : e.kind === 'conflict' ? 'conflict' : ''} ${hl && e.kind !== 'conflict' ? 'hl' : ''} ${focus && !hl ? 'graph-dim' : ''}`} />;
        })}
        {g.nodes
          .filter((n) => !hidden(n.key))
          .map((n) => (
            <g
              key={n.key}
              className={`graph-node ${n.ghost ? `ghost tone-${n.tone}` : ''} ${!n.enabled && !n.ghost ? 'off' : ''} ${picked === n.key ? 'sel' : ''} ${focus && !near.has(n.key) ? 'graph-dim' : ''}`}
              transform={`translate(${n.x} ${n.y})`}
              onMouseEnter={() => onHover(n.key)}
              onMouseLeave={() => onHover(null)}
              onClick={() => {
                if (drag.current?.moved) return;
                onPick(n.key === picked ? null : n.key);
              }}
              onDoubleClick={() => !n.ghost && onOpen(n.key)}
              role="button"
              aria-label={`${n.title}, ${n.version}. ${n.reason}`}
            >
              <title>{`${n.title}\n${n.reason}`}</title>
              <rect width={W} height={H} rx={8} />
              <circle cx={16} cy={H / 2} r={7} fill={TONE_VAR[n.tone]} />
              <text x={16} y={H / 2 + 0.5} textAnchor="middle" dominantBaseline="central" style={{ fill: 'var(--bg-1)', fontSize: 10, fontWeight: 800 }}>
                {GLYPH[n.tone]}
              </text>
              {lod === 'full' && (
                <>
                  <text x={30} y={15}>
                    {n.title.length > 24 ? `${n.title.slice(0, 23)}…` : n.title}
                  </text>
                  <text x={30} y={29} className="sub">
                    {n.version.length > 28 ? `${n.version.slice(0, 27)}…` : n.version}
                  </text>
                </>
              )}
              {lod === 'title' && (
                <text x={30} y={H / 2 + 1} dominantBaseline="central" style={{ fontSize: bigFont }}>
                  {n.title.length > bigChars ? `${n.title.slice(0, bigChars - 1)}…` : n.title}
                </text>
              )}
            </g>
          ))}
      </>
    );
  },
  // the open-mod callback is new on every render but does the same thing
  (a, b) => a.g === b.g && a.lod === b.lod && a.bigFont === b.bigFont && a.bigChars === b.bigChars && a.focus === b.focus && a.picked === b.picked && a.only === b.only,
);

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
  const [hideLibs, setHideLibs] = useState(false);
  // libraries: pulled in as dependencies, needed by three mods or more, and without problems
  const libs = useMemo(() => {
    const out = new Set<string>();
    if (!profile) return out;
    const users = new Map<string, number>();
    for (const m of Object.values(profile.mods)) for (const d of m.deps) if (d.kind === 'requires') users.set(keyOf(d.ref), (users.get(keyOf(d.ref)) ?? 0) + 1);
    const troubled = new Set((report?.issues ?? []).filter((i) => i.severity !== 'info').map((i) => i.subject));
    for (const m of Object.values(profile.mods)) if (m.reason === 'dependency' && (users.get(m.key) ?? 0) >= 3 && !troubled.has(m.key)) out.add(m.key);
    return out;
  }, [profile, report]);
  const g = useMemo(() => (profile ? layout(profile, report, hideLibs ? libs : new Set()) : null), [profile, report, hideLibs, libs]);

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
  // "only its links": everything the picked mod needs and everything that needs it, all the way
  const chain = only && picked ? chainOf(g, picked) : null;
  const hidden = (k: string) => !!chain && !chain.has(k);
  const v = view ?? { x: 0, y: 0, k: 1 };
  // far out, the version line and then all names go; names of problems, the picked and the hovered mod float above
  const lod: 'full' | 'title' | 'dot' = v.k >= 0.55 ? 'full' : v.k >= 0.28 ? 'title' : 'dot';
  const bigFont = Math.round(Math.min(26, 11 / v.k));
  const bigChars = Math.max(6, Math.floor((W - 34) / (bigFont * 0.58)));
  const floating = lod === 'full' ? [] : g.nodes.filter((n) => !hidden(n.key) && (n.key === hover || (lod === 'dot' && (n.key === picked || n.tone === 'err' || n.tone === 'warn')))).slice(0, 40);
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
  const why = picked ? whyInstalled(picked, profile) : null;

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
            <span className="legend-marks" title={t('Значок слева от названия мода')}>
              <b className="mark ok">✓</b> {t('в порядке')}
              <b className="mark warn">!</b> {t('есть замечание')}
              <b className="mark err">×</b> {t('ошибка: может не работать')}
              <b className="mark muted">–</b> {t('выключен или не нужен')}
            </span>
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
          {libs.size > 0 && (
            <label
              className="row muted"
              title={t('Библиотеки — зависимости, которые нужны трём модам и больше: {0}', [...libs].map((k) => profile.mods[k]?.title ?? k).join(', '))}
            >
              <input type="checkbox" checked={hideLibs} onChange={(e) => setHideLibs(e.target.checked)} />
              {t('Скрыть библиотеки ({0})', libs.size)}
            </label>
          )}
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
            <Scene g={g} lod={lod} bigFont={bigFont} bigChars={bigChars} focus={focus} picked={picked} only={only} drag={drag} onPick={setPicked} onHover={setHover} onOpen={(k) => {
              select(k);
              go('mods');
            }} />
            </g>
          </svg>
          {floating.map((n) => (
            <div key={n.key} className={`graph-float ${n.tone}`} style={{ left: (n.x + W / 2) * v.k + v.x, top: n.y * v.k + v.y }}>
              {n.title}
              {n.key === hover && <span className="mono faint"> {n.version}</span>}
            </div>
          ))}
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
            <span className="row" style={{ gap: 6, alignItems: 'flex-start', fontSize: 'var(--fs-sm)' }}>
              <b className={`mark ${pickedNode.tone}`} aria-hidden>
                {GLYPH[pickedNode.tone]}
              </b>
              <span style={{ userSelect: 'text' }}>{pickedNode.reason}</span>
            </span>
            {why && why.length > 1 && (
              <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
                {t('Здесь потому, что нужен: {0}', why.slice(1).map((k) => profile.mods[k]?.title ?? k).join(' → '))}
              </span>
            )}
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
