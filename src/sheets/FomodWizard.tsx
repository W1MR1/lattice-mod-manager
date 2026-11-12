import { useEffect, useMemo, useState } from 'react';
import { Check, ImageOff, Puzzle } from 'lucide-react';
import type { FomodPrompt } from '../../shared/types';
import { pluginType, resolveFiles, validateChoices, walkSteps, type FileState, type FomodChoices, type FomodGroup, type FomodPlugin } from '../../shared/fomod';
import { api } from '../api';
import { plural } from '../format';
import { Modal, Spinner, StatusChip } from '../components/ui';
import { t, tk } from '../../shared/i18n';

const GROUP_HINT: Record<FomodGroup['type'], string> = {
  SelectExactlyOne: tk('выберите один'),
  SelectAtMostOne: tk('не больше одного'),
  SelectAtLeastOne: tk('хотя бы один'),
  SelectAll: tk('ставятся все'),
  SelectAny: tk('любые'),
};

/** Walks the user through each FOMOD installer in turn; resolves with every answer. */
export function FomodWizard({ prompts, onDone, onCancel }: { prompts: FomodPrompt[]; onDone: (choices: Record<string, FomodChoices>) => void; onCancel: () => void }) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, FomodChoices>>({});
  const prompt = prompts[index];
  return (
    <FomodPromptView
      key={prompt.key}
      prompt={prompt}
      position={prompts.length > 1 ? t('Установщик {0} из {1}', index + 1, prompts.length) : undefined}
      onCancel={onCancel}
      onDone={(choices) => {
        const next = { ...answers, [prompt.key]: choices };
        setAnswers(next);
        if (index + 1 < prompts.length) setIndex(index + 1);
        else onDone(next);
      }}
    />
  );
}

/** Pictures of an installer, fetched from its archive once each. */
function useFomodImage(token: string | undefined, rel: string | undefined): { url: string | null; loading: boolean } {
  const [cache, setCache] = useState<Record<string, string | null>>({});
  const key = token && rel ? `${token}|${rel}` : '';
  useEffect(() => {
    if (!key || key in cache) return;
    let live = true;
    void api
      .fomodImage(token!, rel!)
      .catch(() => null)
      .then((url) => live && setCache((c) => ({ ...c, [key]: url })));
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return { url: key ? (cache[key] ?? null) : null, loading: !!key && !(key in cache) };
}

function FomodPromptView({ prompt, position, onDone, onCancel }: { prompt: FomodPrompt; position?: string; onDone: (c: FomodChoices) => void; onCancel: () => void }) {
  const fileState: FileState = useMemo(() => {
    const set = new Set(prompt.activePlugins.map((n) => n.toLowerCase()));
    return (f) => (set.has(f.toLowerCase()) ? 'Active' : 'Missing');
  }, [prompt.activePlugins]);
  const [choices, setChoices] = useState<FomodChoices>(prompt.choices);
  const [step, setStep] = useState(0);
  // the option the pointer or the keyboard is on: its picture and description fill the side pane
  const [focus, setFocus] = useState<FomodPlugin | null>(null);
  const walk = walkSteps(prompt.config, choices, fileState);
  const steps = walk.visible;
  const last = steps.length === 0 || step >= steps.length - 1;
  const current = steps[Math.min(step, steps.length - 1)];
  const errors = validateChoices(prompt.config, walk.choices, fileState);
  const fileCount = resolveFiles(prompt.config, walk.choices, fileState).length;
  const hasImages = !!prompt.token && (!!prompt.config.image || prompt.config.steps.some((s) => s.groups.some((g) => g.plugins.some((p) => p.image))));
  // without a pointer on anything: the first chosen option of the step that has a picture, else the installer's own
  const shown = focus ?? current?.groups.flatMap((g) => g.plugins.filter((p) => walk.choices[current.name]?.[g.name]?.includes(p.name))).find((p) => p.image) ?? null;
  const image = useFomodImage(prompt.token, shown?.image ?? prompt.config.image);

  const toggle = (g: FomodGroup, name: string) => {
    const stepName = current.name;
    const chosen = walk.choices[stepName]?.[g.name] ?? [];
    let next: string[];
    if (g.type === 'SelectExactlyOne') next = [name];
    else if (g.type === 'SelectAtMostOne') next = chosen.includes(name) ? [] : [name];
    else next = chosen.includes(name) ? chosen.filter((n) => n !== name) : [...chosen, name];
    setChoices({ ...walk.choices, [stepName]: { ...walk.choices[stepName], [g.name]: next } });
  };

  return (
    <Modal
      title={prompt.config.moduleName}
      size={hasImages ? 'lg' : undefined}
      sub={
        <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <Puzzle size={14} />
          {[position, `«${prompt.title}»`, steps.length ? t('шаг {0} из {1}', Math.min(step, steps.length - 1) + 1, steps.length) : t('без шагов выбора')].filter(Boolean).join(' · ')}
        </span>
      }
      onClose={onCancel}
      foot={
        <>
          <span className="grow faint">
            {errors.length ? errors[0] : t('Будет установлено: {0}', plural(fileCount, 'файл или папка', 'файла или папки', 'файлов и папок'))}
          </span>
          <button className="btn ghost" onClick={onCancel}>
            {t('Отмена')}
          </button>
          {step > 0 && (
            <button
              className="btn"
              onClick={() => {
                setFocus(null);
                setStep(step - 1);
              }}
            >
              {t('Назад')}
            </button>
          )}
          {last ? (
            <button className="btn primary" disabled={errors.length > 0} onClick={() => onDone(walk.choices)}>
              <Check size={15} /> {t('Установить с этими опциями')}
            </button>
          ) : (
            <button
              className="btn primary"
              onClick={() => {
                setFocus(null);
                setStep(step + 1);
              }}
            >
              {t('Далее')}
            </button>
          )}
        </>
      }
    >
      {current ? (
        <div className={hasImages ? 'fomod-split' : 'col'}>
          <div className="col" style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 'var(--fs-lg)' }}>{current.name}</h3>
            {current.groups.map((g) => {
              const chosen = walk.choices[current.name]?.[g.name] ?? [];
              const single = g.type === 'SelectExactlyOne' || g.type === 'SelectAtMostOne';
              return (
                <div className="col" key={g.name} role={single ? 'radiogroup' : 'group'} aria-label={g.name}>
                  <span className="label">
                    {g.name} · {t(GROUP_HINT[g.type])}
                  </span>
                  <div className="fomod-options">
                    {g.plugins.map((p) => {
                      const type = pluginType(p, walk.flags, fileState);
                      const on = chosen.includes(p.name);
                      const locked = type === 'Required' || type === 'NotUsable' || g.type === 'SelectAll';
                      return (
                        <button
                          key={p.name}
                          className="fomod-option"
                          role={single ? 'radio' : 'checkbox'}
                          aria-checked={on}
                          aria-disabled={locked}
                          disabled={type === 'NotUsable'}
                          onMouseEnter={() => setFocus(p)}
                          onFocus={() => setFocus(p)}
                          onClick={() => !locked && toggle(g, p.name)}
                        >
                          <span className={`fomod-mark ${single ? 'radio' : ''}`} aria-hidden>
                            {on && <Check size={12} strokeWidth={3} />}
                          </span>
                          <span className="grow" style={{ minWidth: 0 }}>
                            <span className="row" style={{ gap: 6 }}>
                              <b>{p.name}</b>
                              {type === 'Recommended' && <StatusChip tone="ok">{t('Рекомендуется')}</StatusChip>}
                              {type === 'Required' && <StatusChip tone="accent">{t('Обязательно')}</StatusChip>}
                              {type === 'NotUsable' && <StatusChip tone="muted">{t('Недоступно')}</StatusChip>}
                            </span>
                            {p.description && !hasImages && <span className="fomod-desc">{p.description}</span>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          {hasImages && (
            <aside className="fomod-preview" aria-live="polite">
              <div className="fomod-picture">
                {image.url ? <img src={image.url} alt={shown?.name ?? prompt.config.moduleName} /> : image.loading ? <Spinner size={18} /> : <ImageOff size={22} aria-label={t('У этой опции нет картинки')} />}
              </div>
              <b>{shown?.name ?? prompt.config.moduleName}</b>
              <span className="fomod-desc">{shown?.description || t('Наведите на опцию, чтобы увидеть её описание и картинку.')}</span>
            </aside>
          )}
        </div>
      ) : (
        <p className="muted">{t('У этого установщика нет вариантов: поставятся обязательные файлы.')}</p>
      )}
    </Modal>
  );
}
