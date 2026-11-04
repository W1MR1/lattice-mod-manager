import { useEffect, useState } from 'react';
import { FolderOpen, Radar } from 'lucide-react';
import type { DetectedGame } from '../../shared/types';
import { api, bridge } from '../api';
import { SOURCE_LABEL } from '../format';
import { useUI } from '../store';
import { Modal, Spinner } from '../components/ui';
import { McContextFields } from './ProfileSheet';

export function AddGameSheet({ onClose }: { onClose: () => void }) {
  const defs = useUI((s) => s.defs);
  const run = useUI((s) => s.run);
  const [detected, setDetected] = useState<DetectedGame[] | null>(null);
  const [defId, setDefId] = useState<string>('');
  const [path, setPath] = useState('');
  const [ctx, setCtx] = useState<{ gameVersion?: string; loader?: string }>({ loader: 'fabric' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .detectGames()
      .then((d) => {
        setDetected(d);
        if (d[0]) {
          setDefId(d[0].defId);
          setPath(d[0].path);
        }
      })
      .catch(() => setDetected([]));
  }, []);

  const def = defs.find((d) => d.id === defId);
  const pick = (id: string) => {
    setDefId(id);
    setPath(detected?.find((d) => d.defId === id)?.path ?? defs.find((d) => d.id === id)?.defaultPath ?? '');
  };

  const add = async () => {
    setBusy(true);
    const g = await run(() => api.addGame(defId, path, def?.kind === 'minecraft' ? ctx : {}), `${def?.name} добавлена`);
    setBusy(false);
    if (g) onClose();
  };

  return (
    <Modal
      title="Добавить игру"
      sub={
        detected === null ? (
          <span className="row">
            <Spinner /> Ищем установленные игры в библиотеках Steam…
          </span>
        ) : detected.length ? (
          `Найдено установленных: ${detected.length}. Выберите игру и проверьте папку.`
        ) : (
          'Установленных игр не найдено — выберите игру и укажите папку вручную.'
        )
      }
      onClose={onClose}
      foot={
        <>
          <span className="grow faint">{def?.notes}</span>
          <button className="btn ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="btn primary" disabled={!defId || !path || busy} onClick={add}>
            {busy && <Spinner />}
            Добавить
          </button>
        </>
      }
    >
      <div className="option-list">
        {defs.map((d) => {
          const found = detected?.some((x) => x.defId === d.id);
          return (
            <button key={d.id} className="option" aria-pressed={defId === d.id} onClick={() => pick(d.id)}>
              <span className="game-tile" style={{ ['--hue' as string]: d.hue, pointerEvents: 'none' }}>
                <span>{d.short}</span>
              </span>
              <span className="col" style={{ gap: 0, minWidth: 0 }}>
                <b className="ellipsis">{d.name}</b>
                <small className={found ? '' : 'faint'} style={found ? { color: 'var(--ok)' } : undefined}>
                  {found ? (
                    <span className="row" style={{ gap: 4 }}>
                      <Radar size={12} /> найдена
                    </span>
                  ) : (
                    d.sources.filter((s) => s !== 'local').map((s) => SOURCE_LABEL[s]).join(' · ')
                  )}
                </small>
              </span>
            </button>
          );
        })}
      </div>
      {def && (
        <div className="form-grid">
          <label htmlFor="gpath">Папка {def.kind === 'minecraft' ? 'экземпляра' : 'игры'}</label>
          <div className="row">
            <input id="gpath" className="input grow mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\…" />
            <button
              className="btn"
              onClick={async () => {
                const p = await bridge.dialog('folder');
                if (p) setPath(p);
              }}
            >
              <FolderOpen size={15} /> Обзор
            </button>
          </div>
          {def.kind === 'minecraft' && <McContextFields version={ctx.gameVersion} loader={ctx.loader} onChange={setCtx} />}
        </div>
      )}
    </Modal>
  );
}
