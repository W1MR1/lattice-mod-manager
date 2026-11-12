import { useEffect, useRef, useState } from 'react';
import { CircleCheck, Clock, ExternalLink, FolderOpen, FolderSearch, SkipForward } from 'lucide-react';
import type { NexusNeed } from '../../shared/types';
import { api, bridge } from '../api';
import { bytes } from '../format';
import { useUI } from '../store';
import { Spinner, StatusChip, Switch } from '../components/ui';
import { t } from '../../shared/i18n';

/**
 * Nexus gives files to free accounts only through its site. This list walks
 * the user through it: one press on the site per file, the rest is Lattice's.
 */
export function NexusChecklist({ planId, needs, onNeeds, onReady }: { planId: string; needs: NexusNeed[]; onNeeds: (n: NexusNeed[]) => void; onReady: () => void }) {
  const run = useUI((s) => s.run);
  const [auto, setAuto] = useState(true);
  const [folder, setFolder] = useState('');
  const opened = useRef(new Set<number>());
  const found = needs.filter((n) => n.state === 'found').length;
  const next = needs.find((n) => n.state === 'waiting' && !opened.current.has(n.fileId)) ?? needs.find((n) => n.state === 'waiting');
  const manager = needs[0]?.via === 'manager';

  useEffect(() => {
    void api.pickupFolder().then(setFolder, () => undefined);
    return bridge.on('nexus', (e) => {
      if (e.planId === planId) onNeeds(e.needs);
    });
  }, [planId]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (n: NexusNeed) => {
    opened.current.add(n.fileId);
    void bridge.openExternal(n.page);
  };

  // a file arrived: the plan goes on when it was the last one, else the next page opens by itself
  const prevFound = useRef(found);
  useEffect(() => {
    if (needs.length > 0 && found === needs.length) onReady();
    else if (found > prevFound.current && auto) {
      const n = needs.find((x) => x.state === 'waiting' && !opened.current.has(x.fileId));
      if (n) open(n);
    }
    prevFound.current = found;
  }, [found, needs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="card card-pad col nexus-help" role="group" aria-label={t('Файлы с Nexus')}>
      <div className="row">
        <b className="grow">{t('Эти файлы Nexus отдаёт только через свой сайт')}</b>
        <StatusChip tone={found === needs.length ? 'ok' : 'info'}>{t('{0} из {1}', found, needs.length)}</StatusChip>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {manager
          ? t('Нажмите «Открыть» и на странице Nexus — «Slow download». Сайт передаст файл в Lattice, и установка пойдёт дальше сама.')
          : t('Нажмите «Открыть» и на странице Nexus — «Slow download». Браузер сохранит архив, Lattice заберёт его из папки загрузок и продолжит установку сам. Ключ и Premium для этого не нужны.')}
      </p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={!next} onClick={() => next && open(next)}>
          <ExternalLink size={15} /> {opened.current.size === 0 ? t('Открыть первый файл на Nexus') : t('Открыть следующий')}
        </button>
        <label className="row muted">
          <Switch on={auto} onChange={setAuto} label={t('Открывать следующую страницу самому')} />
          {t('Открывать следующую страницу самому')}
        </label>
      </div>
      <div className="plan-list">
        {needs.map((n) => (
          <div className="plan-item" key={n.fileId}>
            {n.state === 'found' ? <CircleCheck size={18} className="sev-ok" aria-label={t('Получен')} /> : n.state === 'downloading' ? <Spinner size={16} /> : <Clock size={18} className="sev-info" aria-label={t('Ждёт')} />}
            <div className="mod-name grow">
              <b className="ellipsis">{n.title}</b>
              <small className="ellipsis mono">
                {n.filename}
                {n.size ? ` · ${bytes(n.size)}` : ''}
              </small>
            </div>
            {n.state === 'waiting' && (
              <>
                <button className="btn sm" onClick={() => open(n)}>
                  <ExternalLink size={13} /> {t('Открыть')}
                </button>
                <button
                  className="btn sm ghost icon"
                  title={t('Указать уже скачанный файл')}
                  aria-label={t('Указать уже скачанный файл')}
                  onClick={async () => {
                    const files = await bridge.dialog('files');
                    if (files?.[0]) {
                      const r = await run(() => api.nexusProvide(planId, n.fileId, files[0]));
                      if (r) onNeeds(r);
                    }
                  }}
                >
                  <FolderSearch size={14} />
                </button>
                <button
                  className="btn sm ghost icon"
                  title={t('Не ставить этот мод')}
                  aria-label={t('Не ставить этот мод')}
                  onClick={async () => {
                    const plan = await run(() => api.planDrop(planId, [n.key]));
                    if (plan) {
                      useUI.setState({ plan });
                      onNeeds(needs.filter((x) => x.key !== n.key));
                    }
                  }}
                >
                  <SkipForward size={14} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="row faint" style={{ fontSize: 'var(--fs-sm)' }}>
        <FolderOpen size={13} />
        <span className="grow ellipsis mono" title={folder}>
          {t('Папка загрузок браузера: {0}', folder)}
        </span>
        <button
          className="text-link"
          onClick={async () => {
            const dir = await bridge.dialog('folder');
            if (!dir) return;
            await run(() => api.updateSettings({ pickupDir: dir }));
            setFolder(dir);
            const r = await run(() => api.nexusPickup(planId, true));
            if (r) onNeeds(r);
          }}
        >
          {t('Изменить')}
        </button>
      </div>
    </div>
  );
}
