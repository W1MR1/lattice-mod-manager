import { useEffect, useState } from 'react';
import { CircleCheck, CircleX, Copy, FileText, Info, Save } from 'lucide-react';
import type { JournalEntry } from '../../shared/types';
import { api, bridge } from '../api';
import { useUI } from '../store';
import { Modal, Spinner } from '../components/ui';
import { t } from '../../shared/i18n';

/** Everything Lattice told the user in this session, to read again, copy, or send with a problem report. */
export function JournalSheet({ onClose }: { onClose: () => void }) {
  const toast = useUI((s) => s.toast);
  const run = useUI((s) => s.run);
  const [list, setList] = useState<JournalEntry[] | null>(null);
  const [only, setOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const load = () => void api.journal().then(setList, () => setList([]));
    load();
    const timer = setInterval(load, 2500);
    return () => clearInterval(timer);
  }, []);
  const shown = (list ?? []).filter((e) => !only || e.kind === 'err').slice().reverse();
  const copy = async (text: string, done: string) => {
    await navigator.clipboard.writeText(text);
    toast('ok', done);
  };
  return (
    <Modal
      title={t('Журнал Lattice')}
      sub={t('Что Lattice делал и что пошло не так с момента запуска. Полный журнал — в файле data/logs/lattice.log.')}
      size="lg"
      onClose={onClose}
      foot={
        <>
          <label className="row muted">
            <input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} /> {t('Только ошибки')}
          </label>
          <span className="grow" />
          <button className="btn" disabled={!shown.length} onClick={() => copy(shown.map((e) => `${e.at.slice(11, 19)} ${e.kind.toUpperCase()} ${e.text}`).join('\n'), t('Журнал скопирован'))}>
            <Copy size={14} /> {t('Скопировать журнал')}
          </button>
          <button
            className="btn"
            disabled={busy}
            title={t('Версии, список проблем, журнал игры и журнал Lattice одним текстом — без ключей и имени пользователя')}
            onClick={async () => {
              setBusy(true);
              const text = await run(() => api.problemReport());
              setBusy(false);
              if (text) await copy(text, t('Отчёт о проблеме скопирован: вставьте его в сообщение.'));
            }}
          >
            {busy ? <Spinner /> : <FileText size={14} />} {t('Скопировать отчёт о проблеме')}
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              const file = await bridge.dialog('report-save', 'lattice-report.txt');
              if (file) await run(() => api.saveProblemReport(file), t('Отчёт сохранён'));
            }}
          >
            <Save size={14} /> {t('Сохранить отчёт в файл…')}
          </button>
        </>
      }
    >
      {!list ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <p className="muted">{only ? t('Ошибок в этом сеансе не было.') : t('Журнал пока пуст.')}</p>
      ) : (
        <div className="journal" role="log">
          {shown.map((e, i) => (
            <div className="journal-row" key={`${e.at}${i}`}>
              {e.kind === 'ok' ? <CircleCheck size={15} className="sev-ok" /> : e.kind === 'err' ? <CircleX size={15} className="sev-err" /> : <Info size={15} className="sev-info" />}
              <span className="mono faint">{new Date(e.at).toLocaleTimeString()}</span>
              <span className="grow journal-text">{e.text}</span>
              <button className="btn ghost sm icon" aria-label={t('Копировать')} title={t('Копировать')} onClick={() => copy(e.text, t('Скопировано'))}>
                <Copy size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
