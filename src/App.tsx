import { useEffect } from 'react';
import { CircleCheck, CircleX, Info, X } from 'lucide-react';
import { useActive, useUI } from './store';
import { api } from './api';
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
import { HealthSheet, UpdateSheet } from './sheets/StartupSheets';
import { Spinner } from './components/ui';

function Toasts() {
  const toasts = useUI((s) => s.toasts);
  const dismiss = useUI((s) => s.dismiss);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast" role={t.kind === 'err' ? 'alert' : 'status'}>
          {t.kind === 'ok' ? <CircleCheck size={18} className="ok" /> : t.kind === 'err' ? <CircleX size={18} className="err" /> : <Info size={18} className="info" />}
          <span className="grow">{t.text}</span>
          {t.undo && (
            <button
              className="btn sm"
              onClick={() => {
                dismiss(t.id);
                void useUI.getState().run(() => api.rollback(t.undo!.snapshotId));
              }}
            >
              {t.undo.label}
            </button>
          )}
          <button className="btn ghost sm icon" aria-label="Закрыть" onClick={() => dismiss(t.id)}>
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
  const setAddGame = useUI((s) => s.setAddGame);
  const init = useUI((s) => s.init);
  const { game } = useActive();

  useEffect(() => {
    void init();
  }, [init]);

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
    <div className="app">
      <Rail />
      <main className="main">
        <Header />
        {game ? <Tabs /> : <div className="tabs" />}
        <div className="content">{body()}</div>
        <StatusBar />
      </main>
      <PlanSheet />
      {addGameOpen && <AddGameSheet onClose={() => setAddGame(false)} />}
      {health && <HealthSheet problems={health} onClose={() => useUI.setState({ health: null })} />}
      {update && !health && <UpdateSheet ev={update} onClose={() => useUI.setState({ update: null })} />}
      <Toasts />
    </div>
  );
}
