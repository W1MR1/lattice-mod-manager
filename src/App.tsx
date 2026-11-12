import { useEffect, useState } from 'react';
import { CircleCheck, CircleX, Copy, Info, Upload, X } from 'lucide-react';
import { useActive, useUI } from './store';
import { api, bridge } from './api';
import { Header, Rail, StatusBar, Tabs } from './components/Shell';
import { Mods } from './screens/Mods';
import { Home } from './screens/Home';
import { CommandPalette } from './components/CommandPalette';
import { JournalSheet } from './sheets/JournalSheet';
import { Discover } from './screens/Discover';
import { Graph } from './screens/Graph';
import { Collections } from './screens/Collections';
import { Downloads } from './screens/Downloads';
import { Snapshots } from './screens/Snapshots';
import { Settings } from './screens/Settings';
import { Welcome } from './screens/Welcome';
import { PlanSheet } from './sheets/PlanSheet';
import { AddGameSheet } from './sheets/AddGameSheet';
import { HealthSheet, OfflineBanner, UpdateSheet } from './sheets/StartupSheets';
import { LayoutPicker } from './sheets/LayoutPicker';
import type { LayoutPrompt } from '../shared/types';
import { Spinner } from './components/ui';
import { t } from '../shared/i18n';

function Toasts() {
  const toasts = useUI((s) => s.toasts);
  const dismiss = useUI((s) => s.dismiss);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast" role={toast.kind === 'err' ? 'alert' : 'status'}>
          {toast.kind === 'ok' ? <CircleCheck size={18} className="ok" /> : toast.kind === 'err' ? <CircleX size={18} className="err" /> : <Info size={18} className="info" />}
          <span className="grow">{toast.text}</span>
          {toast.undo && (
            <button
              className="btn sm"
              onClick={() => {
                dismiss(toast.id);
                void useUI.getState().run(() => api.rollback(toast.undo!.snapshotId));
              }}
            >
              {toast.undo.label}
            </button>
          )}
          {toast.kind === 'err' && (
            <button className="btn ghost sm icon" aria-label={t('Копировать текст ошибки')} title={t('Копировать текст ошибки')} onClick={() => void navigator.clipboard.writeText(toast.text)}>
              <Copy size={14} />
            </button>
          )}
          <button className="btn ghost sm icon" aria-label={t("Закрыть")} onClick={() => dismiss(toast.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The picker of archive variants for an installed mod, opened from anywhere (a fix button, the mod card). */
function RelayoutHost() {
  const key = useUI((s) => s.relayout);
  const { profile } = useActive();
  const [prompt, setPrompt] = useState<LayoutPrompt | null>(null);
  useEffect(() => {
    setPrompt(null);
    if (!key || !profile) return;
    let live = true;
    void useUI
      .getState()
      .run(() => api.layoutPrompt(profile.id, key))
      .then((p) => {
        if (!live) return;
        if (p) setPrompt(p);
        else {
          useUI.setState({ relayout: null });
          if (p === null) useUI.getState().toast('info', t('У этого мода нет архива с вариантами: он установлен одним способом.'));
        }
      });
    return () => {
      live = false;
    };
  }, [key, profile?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!key || !profile || !prompt) return null;
  const close = () => useUI.setState({ relayout: null });
  return (
    <LayoutPicker
      prompt={prompt}
      onCancel={close}
      onDone={(choice) => {
        close();
        void useUI.getState().run(() => api.reinstallWithLayout(profile.id, key, choice));
      }}
    />
  );
}

export function App() {
  const ready = useUI((s) => s.ready);
  const route = useUI((s) => s.route);
  const addGameOpen = useUI((s) => s.addGameOpen);
  const health = useUI((s) => s.health);
  const update = useUI((s) => s.update);
  const lang = useUI((s) => s.state?.settings.language);
  const paletteOpen = useUI((s) => s.paletteOpen);
  const journalOpen = useUI((s) => s.journalOpen);
  const setAddGame = useUI((s) => s.setAddGame);
  const init = useUI((s) => s.init);
  const { game, profile } = useActive();
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  // Ctrl+K: commands; Ctrl+F: the search field of the screen; Ctrl+1…7: the tabs
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        useUI.setState((s) => ({ paletteOpen: !s.paletteOpen }));
      } else if (e.key.toLowerCase() === 'f') {
        const el = document.querySelector<HTMLInputElement>('.search input');
        if (el) {
          e.preventDefault();
          el.focus();
          el.select();
        }
      } else if (/^[1-7]$/.test(e.key) && useUI.getState().state?.games.length) {
        e.preventDefault();
        useUI.getState().go((['home', 'mods', 'discover', 'graph', 'collections', 'downloads', 'snapshots'] as const)[Number(e.key) - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Mod files dropped on the window install as local mods of the active profile. */
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!profile) return;
    const paths = [...e.dataTransfer.files].map((f) => bridge.pathForFile(f)).filter((p) => /\.(zip|7z|rar|jar|dll|esp|esm|esl|pak|ba2|bsa)$/i.test(p));
    if (!paths.length) {
      useUI.getState().toast('info', t('Перетащите файлы модов: .zip, .7z, .rar, .jar, .dll, .esp, .esm, .esl, .pak, .ba2, .bsa'));
      return;
    }
    void useUI.getState().openPlan(t('Локальные моды ({0})', paths.length), () => api.importLocal(profile.id, paths));
  };

  useEffect(() => {
    useUI.getState().select(null);
  }, [game?.id]);

  if (!ready) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
        <Spinner size={22} />
      </div>
    );
  }

  const body = () => {
    if (route === 'settings') return <Settings />;
    if (route === 'downloads') return <Downloads />;
    if (!game) return <Welcome />;
    switch (route) {
      case 'mods':
        return <Mods />;
      case 'discover':
        return <Discover />;
      case 'graph':
        return <Graph />;
      case 'collections':
        return <Collections />;
      case 'snapshots':
        return <Snapshots />;
      default:
        return <Home />;
    }
  };

  return (
    // a new language re-renders every screen
    <div
      className="app"
      key={lang}
      onDragOver={(e) => {
        if (!profile || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="drop-overlay" aria-hidden>
          <Upload size={28} />
          <b>{t('Отпустите, чтобы установить как локальные моды')}</b>
          <span>{t('в профиль «{0}»', profile?.name ?? '')}</span>
        </div>
      )}
      <Rail />
      <main className="main">
        <Header />
        {update?.state === 'offline' && <OfflineBanner onClose={() => useUI.setState({ update: null })} />}
        {game ? <Tabs /> : <div className="tabs" />}
        <div className="content">{body()}</div>
        <StatusBar />
      </main>
      <PlanSheet />
      <RelayoutHost />
      {paletteOpen && <CommandPalette onClose={() => useUI.setState({ paletteOpen: false })} />}
      {journalOpen && <JournalSheet onClose={() => useUI.setState({ journalOpen: false })} />}
      {addGameOpen && <AddGameSheet onClose={() => setAddGame(false)} />}
      {health && <HealthSheet problems={health} onClose={() => useUI.setState({ health: null })} />}
      {update && update.state !== 'offline' && !health && <UpdateSheet ev={update} onClose={() => useUI.setState({ update: null })} />}
      <Toasts />
    </div>
  );
}
