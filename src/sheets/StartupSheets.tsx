import { useState } from 'react';
import { CircleCheck, Download, TriangleAlert } from 'lucide-react';
import type { HealthProblem } from '../../shared/types';
import { api, bridge, type UpdateEvent } from '../api';
import { useUI } from '../store';
import { Modal, Spinner } from '../components/ui';

/** Problems found at start (or on demand): fix them, or leave everything as it is. */
export function HealthSheet({ problems, onClose }: { problems: HealthProblem[]; onClose: () => void }) {
  const toast = useUI((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const fixable = problems.filter((p) => p.fixable);
  return (
    <Modal
      title="Lattice нашёл неполадки"
      sub="Проверка при запуске: файлы модов, папки игр, порядок загрузки и кэш загрузок."
      onClose={busy ? () => undefined : onClose}
      foot={
        <>
          <span className="grow" />
          <button className="btn ghost" disabled={busy} onClick={onClose}>
            Оставить как есть
          </button>
          {fixable.length > 0 && (
            <button
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api.repair(fixable.map((p) => p.id));
                  if (r.failed.length) toast('err', `Не всё удалось исправить:\n${r.failed.map((f) => f.error).join('\n')}`);
                  else toast('ok', `Исправлено: ${r.fixed.length}`);
                  onClose();
                } catch (e) {
                  toast('err', (e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy && <Spinner />} Попытаться исправить ({fixable.length})
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
                {!p.fixable && ' Исправить это автоматически нельзя.'}
              </span>
            </span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** A newer release on GitHub: update now, ask next time, or not for a week. */
export function UpdateSheet({ ev, onClose }: { ev: UpdateEvent; onClose: () => void }) {
  const toast = useUI((s) => s.toast);
  const act = (a: 'download' | 'install' | 'snooze') => bridge.update(a).catch((e) => toast('err', String((e as Error).message ?? e)));
  if (ev.state === 'none') {
    return (
      <Modal title="Обновлений нет" sub="У вас последняя версия Lattice." onClose={onClose} size="sm" foot={<><span className="grow" /><button className="btn" onClick={onClose}>Хорошо</button></>}>
        <span />
      </Modal>
    );
  }
  if (ev.state === 'error') {
    return (
      <Modal title="Не удалось проверить обновления" sub={ev.error} onClose={onClose} size="sm" foot={<><span className="grow" /><button className="btn" onClick={onClose}>Закрыть</button></>}>
        <span />
      </Modal>
    );
  }
  return (
    <Modal
      title={ev.state === 'ready' ? 'Обновление скачано' : `Доступна новая версия${'version' in ev ? ` ${ev.version}` : ''}`}
      sub={ev.state === 'ready' ? 'Lattice закроется, установит обновление и откроется снова.' : 'Новая версия есть в релизах Lattice на GitHub.'}
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
              Не предлагать 7 дней
            </button>
            <span className="grow" />
            <button className="btn ghost" onClick={onClose}>
              Позже
            </button>
            <button className="btn primary" onClick={() => void act('download')}>
              <Download size={15} /> Обновить
            </button>
          </>
        ) : ev.state === 'downloading' ? (
          <>
            <span className="grow muted">Скачиваем… {ev.percent}%</span>
            <Spinner />
          </>
        ) : (
          <>
            <span className="grow" />
            <button className="btn ghost" onClick={onClose}>
              При следующем запуске
            </button>
            <button className="btn primary" onClick={() => void act('install')}>
              <CircleCheck size={15} /> Перезапустить и обновить
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
      {ev.state === 'available' && <span className="faint">«Позже» — спросим снова при следующем запуске.</span>}
    </Modal>
  );
}
