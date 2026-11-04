import { useState } from 'react';
import { CircleCheck, Download, RefreshCw, TriangleAlert, WifiOff, X } from 'lucide-react';
import type { HealthProblem } from '../../shared/types';
import { api, bridge, type UpdateEvent } from '../api';
import { useUI } from '../store';
import { Modal, Spinner } from '../components/ui';
import { t } from '../../shared/i18n';

/** Problems found at start (or on demand): fix them, or leave everything as it is. */
export function HealthSheet({ problems, onClose }: { problems: HealthProblem[]; onClose: () => void }) {
  const toast = useUI((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const fixable = problems.filter((p) => p.fixable);
  return (
    <Modal
      title={t("Lattice нашёл неполадки")}
      sub={t("Проверка при запуске: файлы модов, папки игр, порядок загрузки и кэш загрузок.")}
      onClose={busy ? () => undefined : onClose}
      foot={
        <>
          <span className="grow" />
          <button className="btn ghost" disabled={busy} onClick={onClose}>
            {t('Оставить как есть')}
          </button>
          {fixable.length > 0 && (
            <button
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api.repair(fixable.map((p) => p.id));
                  if (r.failed.length) toast('err', t('Не всё удалось исправить:\n{0}', r.failed.map((f) => f.error).join('\n')));
                  else toast('ok', t('Исправлено: {0}', r.fixed.length));
                  onClose();
                } catch (e) {
                  toast('err', (e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy && <Spinner />} {t('Попытаться исправить ({0})', fixable.length)}
            </button>
          )}
        </>
      }
    >
      <div className="issues-strip" style={{ margin: 0 }}>
        {problems.map((p) => (
          <div className="issue-row" key={p.id}>
            <TriangleAlert size={16} className={p.fixable ? 'sev-warn' : 'sev-info'} aria-hidden />
            <span className="msg">
              <b>{p.title}</b>
              <br />
              <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
                {p.detail}
                {!p.fixable && ` ${t('Исправить это автоматически нельзя.')}`}
              </span>
            </span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** The update check at start could not reach GitHub: say so once and keep working. */
export function OfflineBanner({ onClose }: { onClose: () => void }) {
  const toast = useUI((s) => s.toast);
  return (
    <div className="banner" role="status">
      <WifiOff size={16} aria-hidden />
      <span className="grow">
        <b>{t('Нет связи с репозиторием обновлений на GitHub.')}</b> {t('Lattice работает офлайн: моды, профили, коллекции и снимки доступны, поиск и загрузки заработают, когда появится сеть.')}
      </span>
      <button
        className="btn sm"
        onClick={() => {
          onClose();
          void bridge.update('check').catch((e) => toast('err', String((e as Error).message ?? e)));
        }}
      >
        <RefreshCw size={13} /> {t('Повторить')}
      </button>
      <button className="btn ghost sm icon" aria-label={t('Закрыть')} onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  );
}

/** A newer release on GitHub: update now, ask next time, or not for a week. */
export function UpdateSheet({ ev, onClose }: { ev: UpdateEvent; onClose: () => void }) {
  const toast = useUI((s) => s.toast);
  const act = (a: 'download' | 'install' | 'snooze') => bridge.update(a).catch((e) => toast('err', String((e as Error).message ?? e)));
  if (ev.state === 'none') {
    return (
      <Modal title={t("Обновлений нет")} sub={t("У вас последняя версия Lattice.")} onClose={onClose} size="sm" foot={<><span className="grow" /><button className="btn" onClick={onClose}>{t('Хорошо')}</button></>}>
        <span />
      </Modal>
    );
  }
  if (ev.state === 'error') {
    return (
      <Modal title={t("Не удалось проверить обновления")} sub={ev.error} onClose={onClose} size="sm" foot={<><span className="grow" /><button className="btn" onClick={onClose}>{t('Закрыть')}</button></>}>
        <span />
      </Modal>
    );
  }
  return (
    <Modal
      title={ev.state === 'ready' ? t('Обновление скачано') : t('Доступна новая версия{0}', 'version' in ev ? ` ${ev.version}` : '')}
      sub={ev.state === 'ready' ? t('Lattice закроется, установит обновление и откроется снова.') : t('Новая версия есть в релизах Lattice на GitHub.')}
      onClose={ev.state === 'downloading' ? () => undefined : onClose}
      foot={
        ev.state === 'available' ? (
          <>
            <button
              className="btn ghost"
              onClick={() => {
                void act('snooze');
                onClose();
              }}
            >
              {t('Не предлагать 7 дней')}
            </button>
            <span className="grow" />
            <button className="btn ghost" onClick={onClose}>
              {t('Позже')}
            </button>
            <button className="btn primary" onClick={() => void act('download')}>
              <Download size={15} /> {t('Обновить')}
            </button>
          </>
        ) : ev.state === 'downloading' ? (
          <>
            <span className="grow muted">{t('Скачиваем…')} {ev.percent}%</span>
            <Spinner />
          </>
        ) : (
          <>
            <span className="grow" />
            <button className="btn ghost" onClick={onClose}>
              {t('При следующем запуске')}
            </button>
            <button className="btn primary" onClick={() => void act('install')}>
              <CircleCheck size={15} /> {t('Перезапустить и обновить')}
            </button>
          </>
        )
      }
    >
      {ev.state === 'available' && ev.notes ? (
        <p className="muted" style={{ margin: 0, whiteSpace: 'pre-line', maxHeight: 220, overflow: 'auto', userSelect: 'text' }}>
          {ev.notes}
        </p>
      ) : (
        <span />
      )}
      {ev.state === 'available' && <span className="faint">{t('«Позже» — спросим снова при следующем запуске.')}</span>}
    </Modal>
  );
}
