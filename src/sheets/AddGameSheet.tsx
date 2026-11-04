import { useEffect, useState } from 'react';
import { FolderOpen, Radar } from 'lucide-react';
import type { DetectedGame, ManagedGame } from '../../shared/types';
import { api, bridge } from '../api';
import { LOADER_LABEL, SOURCE_LABEL } from '../format';
import { useUI } from '../store';
import { Modal, Spinner } from '../components/ui';
import { GameIcon } from '../components/Icons';
import { McContextFields } from './ProfileSheet';
import { t } from '../../shared/i18n';

const VIA_LABEL: Record<string, string> = {
  steam: 'Steam',
  gog: 'GOG',
  epic: 'Epic Games',
  xbox: 'Xbox',
  official: 'Minecraft Launcher',
  prism: 'Prism Launcher',
  multimc: 'MultiMC',
  legacy: 'Legacy Launcher',
  tlauncher: 'TLauncher',
  curseforge: 'CurseForge',
  modrinth: 'Modrinth App',
  atlauncher: 'ATLauncher',
};

export const viaLabel = (via?: string) => (via && VIA_LABEL[via]) || t('Другая папка');

const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

/** Copies of one game found on this computer: store or launcher, instance, version, folder. */
export function CopyList({ copies, value, onPick }: { copies: DetectedGame[]; value: string; onPick: (c: DetectedGame) => void }) {
  if (!copies.length) return null;
  return (
    <div className="copy-list" role="radiogroup" aria-label={t('Найденные копии игры')}>
      {copies.map((c) => (
        <button key={c.path} role="radio" aria-checked={samePath(value, c.path)} className="copy" onClick={() => onPick(c)}>
          <GameIcon defId={c.defId} exe={c.install.launcherExe} size={28} />
          <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
            <span className="row" style={{ gap: 6, minWidth: 0 }}>
              <b className="ellipsis">{c.label ?? viaLabel(c.via)}</b>
              <span className="chip outline">{viaLabel(c.via)}</span>
              {c.gameVersion && <span className="chip outline mono">{c.gameVersion}</span>}
              {c.loader && <span className="chip outline">{LOADER_LABEL[c.loader] ?? c.loader}</span>}
              {c.hint === 'home' && <span className="faint">{t('отдельная папка версии')}</span>}
            </span>
            <small className="mono faint ellipsis" title={c.path}>
              {c.path}
            </small>
          </span>
        </button>
      ))}
    </div>
  );
}

export function AddGameSheet({ onClose }: { onClose: () => void }) {
  const defs = useUI((s) => s.defs);
  const run = useUI((s) => s.run);
  const [detected, setDetected] = useState<DetectedGame[] | null>(null);
  const [defId, setDefId] = useState<string>('');
  const [path, setPath] = useState('');
  const [ctx, setCtx] = useState<{ gameVersion?: string; loader?: string }>({ loader: 'fabric' });
  const [busy, setBusy] = useState(false);

  const pickCopy = (c: DetectedGame) => {
    setPath(c.path);
    if (c.gameVersion || c.loader) setCtx({ gameVersion: c.gameVersion, loader: c.loader ?? 'fabric' });
  };

  useEffect(() => {
    api
      .detectGames()
      .then((d) => {
        setDetected(d);
        if (d[0]) {
          setDefId(d[0].defId);
          pickCopy(d[0]);
        }
      })
      .catch(() => setDetected([]));
  }, []);

  const def = defs.find((d) => d.id === defId);
  const copies = (detected ?? []).filter((d) => d.defId === defId);
  const pick = (id: string) => {
    setDefId(id);
    const first = detected?.find((d) => d.defId === id);
    if (first) pickCopy(first);
    else setPath(defs.find((d) => d.id === id)?.defaultPath ?? '');
  };

  const add = async () => {
    setBusy(true);
    const g = await run(() => api.addGame(defId, path, def?.kind === 'minecraft' ? ctx : {}), t('{0} добавлена', def?.name));
    setBusy(false);
    if (g) onClose();
  };

  return (
    <Modal
      title={t('Добавить игру')}
      sub={
        detected === null ? (
          <span className="row">
            <Spinner /> {t('Ищем игры в Steam, GOG, Epic, Xbox и лаунчерах Minecraft…')}
          </span>
        ) : detected.length ? (
          t('Найдено установленных: {0}. Выберите игру и проверьте папку.', detected.length)
        ) : (
          t('Установленных игр не найдено — выберите игру и укажите папку вручную.')
        )
      }
      onClose={onClose}
      foot={
        <>
          <span className="grow faint">{def?.notes && t(def.notes)}</span>
          <button className="btn ghost" onClick={onClose}>
            {t('Отмена')}
          </button>
          <button className="btn primary" disabled={!defId || !path || busy} onClick={add}>
            {busy && <Spinner />}
            {t('Добавить')}
          </button>
        </>
      }
    >
      <div className="option-list">
        {defs.map((d) => {
          const n = detected?.filter((x) => x.defId === d.id).length ?? 0;
          return (
            <button key={d.id} className="option" aria-pressed={defId === d.id} onClick={() => pick(d.id)}>
              <GameIcon defId={d.id} exe={detected?.find((x) => x.defId === d.id)?.install.launcherExe} gamePath={detected?.find((x) => x.defId === d.id)?.path} size={32} />
              <span className="col" style={{ gap: 0, minWidth: 0 }}>
                <b className="ellipsis">{d.name}</b>
                <small className={n ? '' : 'faint'} style={n ? { color: 'var(--ok)' } : undefined}>
                  {n ? (
                    <span className="row" style={{ gap: 4 }}>
                      <Radar size={12} /> {n > 1 ? t('найдено копий: {0}', n) : t('найдена')}
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
        <>
          {copies.length > 0 && (
            <div className="col" style={{ gap: 6 }}>
              <span className="label">{def.kind === 'minecraft' ? t('Где запускается игра') : t('Найденные копии игры')}</span>
              <CopyList copies={copies} value={path} onPick={pickCopy} />
              {def.kind === 'minecraft' && <span className="faint" style={{ fontSize: 'var(--fs-sm)' }}>{t('Моды попадут в папку mods выбранного экземпляра — выберите тот, через который вы играете.')}</span>}
            </div>
          )}
          <div className="form-grid">
            <label htmlFor="gpath">{def.kind === 'minecraft' ? t('Папка экземпляра') : t('Папка игры')}</label>
            <div className="row">
              <input id="gpath" className="input grow mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\…" />
              <button
                className="btn"
                onClick={async () => {
                  const p = await bridge.dialog('folder');
                  if (p) setPath(p);
                }}
              >
                <FolderOpen size={15} /> {t('Обзор')}
              </button>
            </div>
            {def.kind === 'minecraft' && <McContextFields version={ctx.gameVersion} loader={ctx.loader} onChange={setCtx} />}
          </div>
        </>
      )}
    </Modal>
  );
}

/** Points an added game at another copy: found ones first, any folder by hand. */
export function ChangeFolderSheet({ game, onClose }: { game: ManagedGame; onClose: () => void }) {
  const run = useUI((s) => s.run);
  const [copies, setCopies] = useState<DetectedGame[] | null>(null);
  const [path, setPath] = useState(game.installPath);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .detectGames()
      .then((d) => setCopies(d.filter((x) => x.defId === game.defId)))
      .catch(() => setCopies([]));
  }, [game.defId]);
  const save = async () => {
    setBusy(true);
    const ok = await run(() => api.setGamePath(game.id, path), t('Папка игры изменена, моды применены заново'));
    setBusy(false);
    if (ok !== undefined) onClose();
  };
  return (
    <Modal
      title={t('Папка игры: {0}', game.name)}
      sub={t('Lattice уберёт моды из текущей папки и разложит их в выбранную.')}
      onClose={onClose}
      foot={
        <>
          <span className="grow" />
          <button className="btn ghost" onClick={onClose}>
            {t('Отмена')}
          </button>
          <button className="btn primary" disabled={!path || busy || samePath(path, game.installPath)} onClick={save}>
            {busy && <Spinner />} {t('Сменить папку')}
          </button>
        </>
      }
    >
      {copies === null ? <Spinner /> : <CopyList copies={copies} value={path} onPick={(c) => setPath(c.path)} />}
      <div className="row">
        <input className="input grow mono" value={path} onChange={(e) => setPath(e.target.value)} aria-label={t('Папка игры')} />
        <button
          className="btn"
          onClick={async () => {
            const p = await bridge.dialog('folder');
            if (p) setPath(p);
          }}
        >
          <FolderOpen size={15} /> {t('Обзор')}
        </button>
      </div>
    </Modal>
  );
}
