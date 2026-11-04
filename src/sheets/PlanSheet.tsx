import { useState } from 'react';
import { ArrowRight, CornerDownRight, Library, Package } from 'lucide-react';
import type { FomodPrompt, InstallPlan, PlanItem } from '../../shared/types';
import type { FomodChoices } from '../../shared/fomod';
import { FomodWizard } from './FomodWizard';
import { api } from '../api';
import { bytes, plural, SOURCE_LABEL, speed } from '../format';
import { useActive, useUI } from '../store';
import { ModIcon, Modal, SegmentBar, SevIcon, Spinner, StatusChip, Switch } from '../components/ui';

export function PlanSheet() {
  const plan = useUI((s) => s.plan);
  const planning = useUI((s) => s.planning);
  const close = useUI((s) => s.closePlan);
  if (planning && !plan) {
    return (
      <Modal title={planning} sub="Подбираем версии и проверяем все связи…" onClose={close} size="sm">
        <div className="row muted" style={{ padding: '8px 0 16px' }}>
          <Spinner size={18} /> Строим граф зависимостей
        </div>
      </Modal>
    );
  }
  if (!plan) return null;
  return <PlanView plan={plan} onClose={close} />;
}

function PlanView({ plan, onClose }: { plan: InstallPlan; onClose: () => void }) {
  const { state, profile } = useActive();
  const downloads = useUI((s) => s.downloads);
  const toast = useUI((s) => s.toast);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const errors = plan.issues.filter((i) => i.severity === 'error');
  const others = plan.issues.filter((i) => i.severity !== 'error');
  const titles = new Map<string, string>([
    ...[...plan.install, ...plan.update].map((i) => [i.key, i.title] as const),
    ...Object.values(profile?.mods ?? {}).map((m) => [m.key, m.title] as const),
    ...(state?.collections ?? []).map((c) => [`collection:${c.id}`, `коллекция «${c.name}»`] as const),
  ]);
  const deps = plan.install.filter((i) => i.reason === 'dependency').length;
  const size = [...plan.install, ...plan.update].reduce((a, i) => a + (i.version.files.find((f) => f.primary)?.size ?? i.version.files[0]?.size ?? 0), 0);
  const nothing = plan.install.length + plan.update.length === 0 && plan.collectionIds.length === 0;
  const names = new Set([...plan.install, ...plan.update].map((i) => i.title));
  const live = downloads.filter((d) => names.has(d.title) && d.state !== 'done');

  const [prompts, setPrompts] = useState<FomodPrompt[] | null>(null);
  const apply = async (choices?: Record<string, FomodChoices>) => {
    setBusy(true);
    try {
      if (!choices) {
        // download first: archives with a FOMOD installer need answers before anything changes
        const pending = await api.inspectPlan(plan.id);
        if (pending.length) {
          setPrompts(pending);
          return;
        }
      }
      await api.applyPlan(plan.id, force, choices ?? {});
      onClose();
    } catch (e) {
      toast('err', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={plan.label}
      sub={
        <div className="plan-summary" style={{ marginTop: 6 }}>
          {plan.install.length > 0 && <span className="chip accent">+ {plan.install.length} установить</span>}
          {deps > 0 && <span className="chip">{plural(deps, 'зависимость', 'зависимости', 'зависимостей')} подтянется</span>}
          {plan.update.length > 0 && <span className="chip info">{plan.update.length} обновить</span>}
          {plan.keep.length > 0 && <span className="chip outline">{plan.keep.length} без изменений</span>}
          {size > 0 && <span className="chip outline mono">≈ {bytes(size)}</span>}
          {plan.ok ? <StatusChip tone="ok">Связи сходятся</StatusChip> : <StatusChip tone="err">{plural(errors.length, 'проблема', 'проблемы', 'проблем')}</StatusChip>}
        </div>
      }
      onClose={busy ? () => undefined : onClose}
      foot={
        <>
          {!plan.ok && (
            <label className="row muted">
              <Switch on={force} onChange={setForce} label="Применить несмотря на ошибки" />
              Применить несмотря на ошибки
            </label>
          )}
          <span className="grow" />
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button className="btn primary" disabled={busy || nothing || (!plan.ok && !force)} onClick={() => apply()}>
            {busy && <Spinner />}
            {busy ? (prompts ? 'Ждём ответов установщика…' : 'Скачиваем и устанавливаем…') : nothing ? 'Нечего менять' : 'Применить'}
          </button>
        </>
      }
    >
      {plan.issues.length > 0 && (
        <div className="issues-strip" style={{ margin: 0 }}>
          {[...errors, ...others].map((i) => (
            <div className="issue-row" key={i.id}>
              <SevIcon s={i.severity} />
              <span className="msg">{i.message}</span>
              {i.fix?.kind === 'install' && plan.collectionIds.length === 0 && (
                <button
                  className="btn sm"
                  onClick={() =>
                    useUI.getState().openPlan(plan.label, () =>
                      api.planInstall(plan.profileId, [
                        ...plan.install.filter((x) => x.reason !== 'dependency').map((x) => ({ ref: x.version.ref, versionId: x.version.versionId, title: x.title })),
                        { ref: i.fix!.ref!, versionId: i.fix!.versionId },
                      ]),
                    )
                  }
                >
                  {i.fix.label}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {live.length > 0 && (
        <div className="card">
          {live.map((d) => (
            <div className="dl" key={d.id}>
              <div className="row">
                <b className="grow ellipsis">{d.title}</b>
                <span className="mono muted">
                  {speed(d.speed)} · {d.connections} пот.
                </span>
              </div>
              <SegmentBar d={d} />
            </div>
          ))}
        </div>
      )}

      {plan.install.length > 0 && <Section title="Будет установлено" items={plan.install} titles={titles} />}
      {plan.update.length > 0 && <Section title="Будет обновлено" items={plan.update} titles={titles} />}
      {nothing && <p className="muted">Всё уже установлено в нужных версиях — профиль не изменится.</p>}
      {prompts && (
        <FomodWizard
          prompts={prompts}
          onCancel={() => setPrompts(null)}
          onDone={(choices) => {
            setPrompts(null);
            void apply(choices);
          }}
        />
      )}
    </Modal>
  );
}

function Section({ title, items, titles }: { title: string; items: PlanItem[]; titles: Map<string, string> }) {
  const sorted = [...items].sort((a, b) => (a.reason === 'dependency' ? 1 : 0) - (b.reason === 'dependency' ? 1 : 0));
  return (
    <div className="col">
      <span className="label">{title}</span>
      <div className="plan-list">
        {sorted.map((i) => (
          <div className="plan-item" key={i.key}>
            <ModIcon url={i.iconUrl} title={i.title} />
            <div className="mod-name grow">
              <b className="ellipsis">{i.title}</b>
              <small className="ellipsis">
                {i.reason === 'dependency' ? (
                  <span className="row" style={{ gap: 4 }}>
                    <CornerDownRight size={12} /> нужен для {i.requiredBy.map((k) => titles.get(k) ?? k).join(', ') || '—'}
                  </span>
                ) : i.reason === 'collection' ? (
                  <span className="row" style={{ gap: 4 }}>
                    <Library size={12} /> {i.requiredBy.map((k) => titles.get(k) ?? k).join(', ')}
                  </span>
                ) : (
                  <span className="row" style={{ gap: 4 }}>
                    <Package size={12} /> по вашему запросу
                  </span>
                )}
              </small>
            </div>
            <span className="chip outline">{SOURCE_LABEL[i.version.ref.source]}</span>
            <span className="mono muted row" style={{ gap: 4 }}>
              {i.fromVersion && (
                <>
                  {i.fromVersion} <ArrowRight size={12} />
                </>
              )}
              {i.version.version}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
