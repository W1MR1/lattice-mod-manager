import { useState } from 'react';
import { CircleCheck, CircleX, Compass, Download, History, Info, Layers, Library, Network, Play, Plus, RefreshCw, Settings, Zap } from 'lucide-react';
import { api } from '../api';
import { ago, bytes, LOADER_LABEL, plural, speed } from '../format';
import { useActive, useUI, type Route } from '../store';
import { HealthRing, Spinner } from './ui';
import { ProfileSheet } from '../sheets/ProfileSheet';
import { t, tk } from '../../shared/i18n';

export function LatticeMark({ size = 26 }: { size?: number }) {
  // Original mark: four nodes on a rhombus, joined like a lattice.
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" fill="none" aria-label="Lattice">
      <path d="M13 3 L23 13 L13 23 L3 13 Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" opacity="0.55" />
      <path d="M8 8 L18 18 M18 8 L8 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.55" />
      <circle cx="13" cy="3.5" r="2.4" fill="currentColor" />
      <circle cx="22.5" cy="13" r="2.4" fill="currentColor" />
      <circle cx="13" cy="22.5" r="2.4" fill="currentColor" />
      <circle cx="3.5" cy="13" r="2.4" fill="currentColor" />
    </svg>
  );
}

export function Rail() {
  const state = useUI((s) => s.state);
  const defs = useUI((s) => s.defs);
  const route = useUI((s) => s.route);
  const go = useUI((s) => s.go);
  const setAddGame = useUI((s) => s.setAddGame);
  const run = useUI((s) => s.run);
  const active = useUI((s) => s.downloads.filter((d) => d.state === 'downloading' || d.state === 'probing' || d.state === 'queued').length);
  const activeId = state?.activeGameId ?? state?.games[0]?.id;
  return (
    <nav className="rail" aria-label={t("Игры")}>
      <div className="rail-mark">
        <LatticeMark />
      </div>
      {state?.games.map((g) => {
        const def = defs.find((d) => d.id === g.defId);
        return (
          <button
            key={g.id}
            className="game-tile"
            style={{ ['--hue' as string]: def?.hue ?? 260 }}
            aria-current={g.id === activeId}
            title={g.name}
            onClick={() => run(() => api.setActiveGame(g.id))}
          >
            <span>{def?.short ?? g.name.slice(0, 2)}</span>
          </button>
        );
      })}
      <button className="rail-btn" title={t("Добавить игру")} aria-label={t("Добавить игру")} onClick={() => setAddGame(true)}>
        <Plus size={18} />
      </button>
      <div className="rail-spacer" />
      <button className="rail-btn solid" title={t("Загрузки")} aria-label={t("Загрузки")} aria-current={route === 'downloads'} onClick={() => go('downloads')}>
        <Download size={18} />
        {active > 0 && <span className="rail-badge">{active}</span>}
      </button>
      <button className="rail-btn solid" title={t("Настройки")} aria-label={t("Настройки")} aria-current={route === 'settings'} onClick={() => go('settings')}>
        <Settings size={18} />
      </button>
    </nav>
  );
}

export function Header() {
  const { game, profile, def, state } = useActive();
  const report = useUI((s) => s.report);
  const go = useUI((s) => s.go);
  const run = useUI((s) => s.run);
  const [deploying, setDeploying] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [profileSheet, setProfileSheet] = useState(false);
  if (!game || !profile) {
    return (
      <header className="header">
        <div className="header-title">
          <h1>Lattice</h1>
          <span className="faint">{t('Менеджер модов и коллекций')}</span>
        </div>
        <div className="drag-fill" />
      </header>
    );
  }
  const profiles = state!.profiles.filter((p) => p.gameId === game.id);
  const ctx = profile.context;
  return (
    <header className="header">
      <div className="header-title">
        <h1 className="ellipsis">{game.name}</h1>
      </div>
      <div className="row">
        <select
          className="select"
          aria-label={t("Профиль")}
          value={profile.id}
          onChange={(e) => {
            if (e.target.value === '__new') setProfileSheet(true);
            else run(() => api.switchProfile(game.id, e.target.value));
          }}
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {plural(Object.keys(p.mods).length, 'мод', 'мода', 'модов')}
            </option>
          ))}
          <option value="__new">{t('＋ Новый профиль…')}</option>
        </select>
        {def?.kind === 'minecraft' && (
          <span className="ctx-chip" title={t("Версия игры и загрузчик профиля")}>
            <span className="mono">{ctx.gameVersion ?? t('любая')}</span>·{LOADER_LABEL[ctx.loader ?? ''] ?? ctx.loader ?? '—'}
          </span>
        )}
      </div>
      <div className="drag-fill" />
      {report && (
        <button className="health" onClick={() => go('graph')} title={t("Открыть граф совместимости")}>
          <HealthRing score={report.score} />
          <span className="health-text">
            <b>{report.errors ? plural(report.errors, 'ошибка', 'ошибки', 'ошибок') : report.warnings ? plural(report.warnings, 'предупреждение', 'предупреждения', 'предупреждений') : t('Сборка цела')}</b>
            <small>{t('совместимость')}</small>
          </span>
        </button>
      )}
      <button
        className="btn"
        disabled={deploying}
        title={t('Кладёт моды профиля в папку игры и убирает выключенные. Делается само после каждого изменения — нажмите, если файлы в папке игры поменялись. {0}', profile.deployedAt ? t('Последний раз: {0}.', ago(profile.deployedAt)) : t('Ещё не применялось.'))}
        onClick={async () => {
          setDeploying(true);
          const r = await run(() => api.deploy(profile.id));
          setDeploying(false);
          if (r) useUI.getState().toast('ok', t('Моды в папке игры: {0}\nНовых файлов {1}, убрано {2}{3}', r.root, r.deployed, r.removed, r.backedUp ? t(', сохранено оригиналов {0}', r.backedUp) : ''));
        }}
      >
        {deploying ? <Spinner /> : <RefreshCw size={15} />}
        {t('Применить к игре')}
      </button>
      <button
        className="btn primary"
        disabled={launching}
        title={t("Применить моды и запустить игру")}
        onClick={async () => {
          setLaunching(true);
          const r = await run(() => api.launchGame(game.id));
          setLaunching(false);
          if (r) useUI.getState().toast('info', r.note);
        }}
      >
        {launching ? <Spinner /> : <Play size={15} />}
        {t('Играть')}
      </button>
      {profileSheet && <ProfileSheet gameId={game.id} onClose={() => setProfileSheet(false)} />}
    </header>
  );
}

const TABS: { id: Route; label: string; icon: typeof Layers }[] = [
  { id: 'mods', label: tk('Моды'), icon: Layers },
  { id: 'discover', label: tk('Обзор'), icon: Compass },
  { id: 'graph', label: tk('Граф связей'), icon: Network },
  { id: 'collections', label: tk('Коллекции'), icon: Library },
  { id: 'downloads', label: tk('Загрузки'), icon: Download },
  { id: 'snapshots', label: tk('Снимки'), icon: History },
];

export function Tabs() {
  const route = useUI((s) => s.route);
  const go = useUI((s) => s.go);
  const report = useUI((s) => s.report);
  const { profile, state } = useActive();
  const activeDl = useUI((s) => s.downloads.filter((d) => ['downloading', 'probing', 'queued'].includes(d.state)).length);
  const counts: Partial<Record<Route, { n: number; err?: boolean }>> = {
    mods: { n: profile ? Object.keys(profile.mods).length : 0 },
    graph: report ? { n: report.errors + report.warnings, err: report.errors > 0 } : undefined,
    collections: { n: state?.collections.length ?? 0 },
    downloads: { n: activeDl },
    snapshots: { n: state?.snapshots.filter((s) => s.profileId === profile?.id).length ?? 0 },
  };
  return (
    <div className="tabs" role="tablist">
      {TABS.map((tab) => {
        const c = counts[tab.id];
        return (
          <button key={tab.id} role="tab" className="tab" aria-selected={route === tab.id} onClick={() => go(tab.id)}>
            <tab.icon size={15} />
            {t(tab.label)}
            {c && c.n > 0 && <span className={`tab-count ${c.err ? 'err' : ''}`}>{c.n}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function StatusBar() {
  const downloads = useUI((s) => s.downloads);
  const { profile, state } = useActive();
  const total = downloads.reduce((a, d) => a + d.speed, 0);
  const conns = downloads.reduce((a, d) => a + d.connections, 0);
  const live = downloads.filter((d) => d.state === 'downloading').length;
  return (
    <footer className="statusbar">
      <span className="row" title={t("Суммарная скорость. Ограничений скорости нет.")}>
        <Zap size={13} />
        <span className="mono">{speed(total)}</span>
      </span>
      <span className="row">
        <Download size={13} />
        {live ? `${plural(live, 'загрузка', 'загрузки', 'загрузок')} · ${plural(conns, 'поток', 'потока', 'потоков')}` : t('Загрузок нет')}
      </span>
      {profile && (
        <span className="row">
          {profile.deployedAt ? <CircleCheck size={13} color="var(--ok)" /> : <CircleX size={13} color="var(--warn)" />}
          {profile.deployedAt ? t('Применено к игре {0} · {1}', ago(profile.deployedAt), state?.settings.deployMethod === 'hardlink' ? t('жёсткие ссылки') : t('копии')) : t('Ещё не применено к игре')}
        </span>
      )}
      <span className="grow" />
      <span className="row faint">
        <Info size={13} />
        {t('кэш загрузок за сессию: {0}', bytes(downloads.filter((d) => d.state === 'done').reduce((a, d) => a + d.size, 0)))}
      </span>
    </footer>
  );
}
