import { useEffect, useState } from 'react';
import { CircleCheck, CircleX, Copy, Info, Upload, X } from 'lucide-react';
import { useActive, useUI } from './store';
import { api, bridge } from './api';
import { Header, Rail, StatusBar, Tabs } from './components/Shell';
import { Mods } from './screens/Mods';
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

export function App() {
  const ready = useUI((s) => s.ready);
  const route = useUI((s) => s.route);
  const addGameOpen = useUI((s) => s.addGameOpen);
  const health = useUI((s) => s.health);
  const update = useUI((s) => s.update);
  const lang = useUI((s) => s.state?.settings.language);
  const setAddGame = useUI((s) => s.setAddGame);
  const init = useUI((s) => s.init);
  const { game, profile } = useActive();
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  // Ctrl+F: the search field of the screen; Ctrl+1…6: the tabs
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key.toLowerCase() === 'f') {
        const el = document.querySelector<HTMLInputElement>('.search input');
        if (el) {
          e.preventDefault();
          el.focus();
          el.select();
        }
      } else if (/^[1-6]$/.test(e.key) && useUI.getState().state?.games.length) {
        e.preventDefault();
        useUI.getState().go((['mods', 'discover', 'graph', 'collections', 'downloads', 'snapshots'] as const)[Number(e.key) - 1]);
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
      case 'discover':
        return <Discover />;
      case 'graph':
        return <Graph />;
      case 'collections':
        return <Collections />;
      case 'snapshots':
        return <Snapshots />;
      default:
        return <Mods />;
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
      {addGameOpen && <AddGameSheet onClose={() => setAddGame(false)} />}
      {health && <HealthSheet problems={health} onClose={() => useUI.setState({ health: null })} />}
      {update && update.state !== 'offline' && !health && <UpdateSheet ev={update} onClose={() => useUI.setState({ update: null })} />}
      <Toasts />
    </div>
  );
}
