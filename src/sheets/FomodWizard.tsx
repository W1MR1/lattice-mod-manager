import { useMemo, useState } from 'react';
import { Check, Puzzle } from 'lucide-react';
import type { FomodPrompt } from '../../shared/types';
import { pluginType, resolveFiles, validateChoices, walkSteps, type FileState, type FomodChoices, type FomodGroup } from '../../shared/fomod';
import { plural } from '../format';
import { Modal, StatusChip } from '../components/ui';

const GROUP_HINT: Record<FomodGroup['type'], string> = {
  SelectExactlyOne: 'выберите один',
  SelectAtMostOne: 'не больше одного',
  SelectAtLeastOne: 'хотя бы один',
  SelectAll: 'ставятся все',
  SelectAny: 'любые',
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
      position={prompts.length > 1 ? `Установщик ${index + 1} из ${prompts.length}` : undefined}
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

function FomodPromptView({ prompt, position, onDone, onCancel }: { prompt: FomodPrompt; position?: string; onDone: (c: FomodChoices) => void; onCancel: () => void }) {
  const fileState: FileState = useMemo(() => {
    const set = new Set(prompt.activePlugins.map((n) => n.toLowerCase()));
    return (f) => (set.has(f.toLowerCase()) ? 'Active' : 'Missing');
  }, [prompt.activePlugins]);
  const [choices, setChoices] = useState<FomodChoices>(prompt.choices);
  const [step, setStep] = useState(0);
  const walk = walkSteps(prompt.config, choices, fileState);
  const steps = walk.visible;
  const last = steps.length === 0 || step >= steps.length - 1;
  const current = steps[Math.min(step, steps.length - 1)];
  const errors = validateChoices(prompt.config, walk.choices, fileState);
  const fileCount = resolveFiles(prompt.config, walk.choices, fileState).length;

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
      sub={
        <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <Puzzle size={14} />
          {[position, `«${prompt.title}»`, steps.length ? `шаг ${Math.min(step, steps.length - 1) + 1} из ${steps.length}` : 'без шагов выбора'].filter(Boolean).join(' · ')}
        </span>
      }
      onClose={onCancel}
      foot={
        <>
          <span className="grow faint">
            {errors.length ? errors[0] : `Будет установлено: ${plural(fileCount, 'файл или папка', 'файла или папки', 'файлов и папок')}`}
          </span>
          <button className="btn ghost" onClick={onCancel}>
            Отмена
          </button>
          {step > 0 && (
            <button className="btn" onClick={() => setStep(step - 1)}>
              Назад
            </button>
          )}
          {last ? (
            <button className="btn primary" disabled={errors.length > 0} onClick={() => onDone(walk.choices)}>
              <Check size={15} /> Установить с этими опциями
            </button>
          ) : (
            <button className="btn primary" onClick={() => setStep(step + 1)}>
              Далее
            </button>
          )}
        </>
      }
    >
      {current ? (
        <>
          <h3 style={{ margin: 0, fontSize: 'var(--fs-lg)' }}>{current.name}</h3>
          {current.groups.map((g) => {
            const chosen = walk.choices[current.name]?.[g.name] ?? [];
            const single = g.type === 'SelectExactlyOne' || g.type === 'SelectAtMostOne';
            return (
              <div className="col" key={g.name} role={single ? 'radiogroup' : 'group'} aria-label={g.name}>
                <span className="label">
                  {g.name} · {GROUP_HINT[g.type]}
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
                        onClick={() => !locked && toggle(g, p.name)}
                      >
                        <span className={`fomod-mark ${single ? 'radio' : ''}`} aria-hidden>
                          {on && <Check size={12} strokeWidth={3} />}
                        </span>
                        <span className="grow" style={{ minWidth: 0 }}>
                          <span className="row" style={{ gap: 6 }}>
                            <b>{p.name}</b>
                            {type === 'Recommended' && <StatusChip tone="ok">Рекомендуется</StatusChip>}
                            {type === 'Required' && <StatusChip tone="accent">Обязательно</StatusChip>}
                            {type === 'NotUsable' && <StatusChip tone="muted">Недоступно</StatusChip>}
                          </span>
                          {p.description && <span className="fomod-desc">{p.description}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </>
      ) : (
        <p className="muted">У этого установщика нет вариантов: поставятся обязательные файлы.</p>
      )}
    </Modal>
  );
}
