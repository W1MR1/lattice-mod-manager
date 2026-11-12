import { useState } from 'react';
import { Check, FolderTree } from 'lucide-react';
import type { LayoutChoice, LayoutPrompt } from '../../shared/types';
import { plural } from '../format';
import { Modal } from '../components/ui';
import { t } from '../../shared/i18n';

const TOP_FILES = './';
const AUTO = '__auto__';

/** Asks about each archive in turn that has variants or a layout Lattice does not recognise. */
export function LayoutWizard({ prompts, onDone, onCancel }: { prompts: LayoutPrompt[]; onDone: (answers: Record<string, LayoutChoice>) => void; onCancel: () => void }) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, LayoutChoice>>({});
  const prompt = prompts[index];
  return (
    <LayoutPicker
      key={prompt.key}
      prompt={prompt}
      position={prompts.length > 1 ? t('Архив {0} из {1}', index + 1, prompts.length) : undefined}
      onCancel={onCancel}
      onDone={(choice) => {
        const next = { ...answers, [prompt.key]: choice };
        setAnswers(next);
        if (index + 1 < prompts.length) setIndex(index + 1);
        else onDone(next);
      }}
    />
  );
}

/** Which parts of one archive to install, and (when Lattice cannot tell) where they go. */
export function LayoutPicker({ prompt, position, onDone, onCancel }: { prompt: LayoutPrompt; position?: string; onDone: (c: LayoutChoice) => void; onCancel: () => void }) {
  const whole = prompt.choice.roots.includes('');
  const [picked, setPicked] = useState<string[]>(whole ? [] : prompt.choice.roots);
  const [all, setAll] = useState(whole);
  const [dest, setDest] = useState<string>(prompt.choice.dest ?? (prompt.reason === 'unknown' ? (prompt.dests[0]?.id ?? '') : AUTO));
  const toggle = (path: string) => {
    setAll(false);
    setPicked((cur) => (cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path]));
  };
  const files = all ? prompt.options.reduce((a, o) => a + o.files, 0) : prompt.options.filter((o) => picked.includes(o.path)).reduce((a, o) => a + o.files, 0);
  const why =
    prompt.reason === 'variants'
      ? t('В архиве несколько вариантов. Отметьте то, что нужно: если отмечено несколько, файлы следующих ложатся поверх предыдущих.')
      : prompt.reason === 'unknown'
        ? t('Lattice не узнал, как устроен этот архив. Отметьте, что из него ставить, и укажите, куда: так, как написано на странице мода.')
        : t('Что из архива поставить. «Как решит Lattice» раскладывает файлы по правилам игры; место можно указать и самому.');
  return (
    <Modal
      title={prompt.title}
      sub={
        <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <FolderTree size={14} />
          {[position, prompt.reason === 'variants' ? t('выбор варианта') : prompt.reason === 'unknown' ? t('куда положить файлы') : t('состав и место')].filter(Boolean).join(' · ')}
        </span>
      }
      onClose={onCancel}
      foot={
        <>
          <span className="grow faint">{files ? t('Будет установлено: {0}', plural(files, 'файл', 'файла', 'файлов')) : t('Ничего не отмечено')}</span>
          <button className="btn ghost" onClick={onCancel}>
            {t('Отмена')}
          </button>
          <button className="btn primary" disabled={!all && picked.length === 0} onClick={() => onDone({ roots: all ? [''] : prompt.options.map((o) => o.path).filter((p) => picked.includes(p)), dest: dest === AUTO ? undefined : dest })}>
            <Check size={15} /> {t('Установить')}
          </button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>
        {why}
      </p>
      <div className="fomod-options" role="group" aria-label={t('Части архива')}>
        {prompt.reason === 'extras' && (
          <button className="fomod-option" role="checkbox" aria-checked={all} onClick={() => setAll(!all)}>
            <span className="fomod-mark" aria-hidden>
              {all && <Check size={12} strokeWidth={3} />}
            </span>
            <span className="grow" style={{ minWidth: 0 }}>
              <b>{t('Весь архив')}</b>
              <span className="fomod-desc">{t('Как ставится по умолчанию')}</span>
            </span>
          </button>
        )}
        {prompt.options.map((o) => {
          const on = !all && picked.includes(o.path);
          return (
            <button key={o.path} className="fomod-option" role="checkbox" aria-checked={on} onClick={() => toggle(o.path)}>
              <span className="fomod-mark" aria-hidden>
                {on && <Check size={12} strokeWidth={3} />}
              </span>
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="row" style={{ gap: 6 }}>
                  <b className="ellipsis">{o.path === TOP_FILES ? t('Файлы в корне архива') : o.path.replace(/\/$/, '')}</b>
                  <span className="faint">{plural(o.files, 'файл', 'файла', 'файлов')}</span>
                </span>
                <span className="fomod-desc mono ellipsis">{o.sample.join('  ·  ')}</span>
              </span>
            </button>
          );
        })}
      </div>
      <label className="col" style={{ gap: 6 }}>
        <span className="label">{t('Куда положить')}</span>
        <select className="select" value={dest} onChange={(e) => setDest(e.target.value)}>
          {prompt.reason !== 'unknown' && <option value={AUTO}>{t('Как решит Lattice (по правилам игры)')}</option>}
          {prompt.dests.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
    </Modal>
  );
}
