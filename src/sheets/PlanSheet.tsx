import { useState } from 'react';
import { ArrowRight, CornerDownRight, Library, Package } from 'lucide-react';
import type { InstallPlan, LayoutChoice, NexusNeed, PlanItem, PlanPrompts } from '../../shared/types';
import type { FomodChoices } from '../../shared/fomod';
import { FomodWizard } from './FomodWizard';
import { LayoutWizard } from './LayoutPicker';
import { NexusChecklist } from './NexusChecklist';
import { api } from '../api';
import { bytes, plural, SOURCE_LABEL, speed } from '../format';
import { useActive, useUI } from '../store';
import { ModIcon, Modal, SegmentBar, SevIcon, Spinner, StatusChip, Switch } from '../components/ui';
import { t } from '../../shared/i18n';

export function PlanSheet() {
  const plan = useUI((s) => s.plan);
  const planning = useUI((s) => s.planning);
  const close = useUI((s) => s.closePlan);
  if (planning && !plan) {
    return (
      <Modal title={planning} sub={t("Подбираем версии и проверяем все связи…")} onClose={close} size="sm">
        <div className="row muted" style={{ padding: '8px 0 16px' }}>
          <Spinner size={18} /> {t('Строим граф зависимостей')}
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
    ...(state?.collections ?? []).map((c) => [`collection:${c.id}`, t('коллекция «{0}»', c.name)] as const),
  ]);
  const deps = plan.install.filter((i) => i.reason === 'dependency').length;
  const size = [...plan.install, ...plan.update].reduce((a, i) => a + (i.version.files.find((f) => f.primary)?.size ?? i.version.files[0]?.size ?? 0), 0);
  const nothing = plan.install.length + plan.update.length === 0 && plan.collectionIds.length === 0;
  const names = new Set([...plan.install, ...plan.update].map((i) => i.title));
  const live = downloads.filter((d) => names.has(d.title) && d.state !== 'done');

  // questions the archives raise once they are downloaded: installer options first, then variants
  const [prompts, setPrompts] = useState<PlanPrompts | null>(null);
  const [answers, setAnswers] = useState<Record<string, FomodChoices> | null>(null);
  // Nexus files a free account has to fetch through the site, before anything else can go on
  const [needs, setNeeds] = useState<NexusNeed[] | null>(null);
  const apply = async (choices?: Record<string, FomodChoices>, layouts?: Record<string, LayoutChoice>) => {
    setBusy(true);
    try {
      const waiting = await api.nexusPickup(plan.id, true);
      if (waiting.some((n) => n.state !== 'found')) {
        setNeeds(waiting);
        return;
      }
      setNeeds(null);
      let pending = prompts;
      if (!pending) {
        // download first: archives that need answers get them before anything changes
        pending = await api.inspectPlan(plan.id);
        setPrompts(pending);
      }
      if (pending.fomod.length && !choices) return;
      if (pending.layout.length && !layouts) {
        setAnswers(choices ?? {});
        return;
      }
      await api.applyPlan(plan.id, force, choices ?? {}, layouts ?? {});
      onClose();
    } catch (e) {
      toast('err', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cancelPrompts = () => {
    setPrompts(null);
    setAnswers(null);
  };

  return (
    <Modal
      title={plan.label}
      sub={
        <div className="plan-summary" style={{ marginTop: 6 }}>
          {plan.install.length > 0 && <span className="chip accent">{t('+ {0} установить', plan.install.length)}</span>}
          {deps > 0 && <span className="chip">{t('{0} подтянется', plural(deps, 'зависимость', 'зависимости', 'зависимостей'))}</span>}
          {plan.update.length > 0 && <span className="chip info">{t('{0} обновить', plan.update.length)}</span>}
          {plan.keep.length > 0 && <span className="chip outline">{t('{0} без изменений', plan.keep.length)}</span>}
          {size > 0 && <span className="chip outline mono">≈ {bytes(size)}</span>}
          {plan.ok ? <StatusChip tone="ok">{t('Связи сходятся')}</StatusChip> : <StatusChip tone="err">{plural(errors.length, 'проблема', 'проблемы', 'проблем')}</StatusChip>}
        </div>
      }
      onClose={busy ? () => undefined : onClose}
      foot={
        <>
          {!plan.ok && (
            <label className="row muted">
              <Switch on={force} onChange={setForce} label={t("Применить несмотря на ошибки")} />
              {t('Применить несмотря на ошибки')}
            </label>
          )}
          <span className="grow" />
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            {t('Отмена')}
          </button>
          <button className="btn primary" disabled={busy || nothing || (!plan.ok && !force) || !!needs} onClick={() => apply()}>
            {busy && <Spinner />}
            {busy ? t('Скачиваем и устанавливаем…') : needs ? t('Ждём файлы с Nexus…') : nothing ? t('Нечего менять') : t('Применить')}
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

      {/* the last waited file taken out of the plan leaves nothing to wait for: the plan goes on without the list */}
      {needs && <NexusChecklist planId={plan.id} needs={needs} onNeeds={(n) => setNeeds(n.length ? n : null)} onReady={() => void apply()} />}

      {live.length > 0 && (
        <div className="card">
          {live.map((d) => (
            <div className="dl" key={d.id}>
              <div className="row">
                <b className="grow ellipsis">{d.title}</b>
                <span className="mono muted">
                  {speed(d.speed)} · {d.connections} {t('пот.')}
                </span>
              </div>
              <SegmentBar d={d} />
            </div>
          ))}
        </div>
      )}

      {plan.install.length > 0 && <Section title={t("Будет установлено")} items={plan.install} titles={titles} />}
      {plan.update.length > 0 && <Section title={t("Будет обновлено")} items={plan.update} titles={titles} />}
      {nothing && <p className="muted">{t('Всё уже установлено в нужных версиях — профиль не изменится.')}</p>}
      {prompts && prompts.fomod.length > 0 && !answers && !busy && <FomodWizard prompts={prompts.fomod} onCancel={cancelPrompts} onDone={(choices) => void apply(choices)} />}
      {prompts && prompts.layout.length > 0 && answers && !busy && <LayoutWizard prompts={prompts.layout} onCancel={cancelPrompts} onDone={(layouts) => void apply(answers, layouts)} />}
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
                    <CornerDownRight size={12} /> {t('нужен для {0}', i.requiredBy.map((k) => titles.get(k) ?? k).join(', ') || '—')}
                  </span>
                ) : i.reason === 'collection' ? (
                  <span className="row" style={{ gap: 4 }}>
                    <Library size={12} /> {i.requiredBy.map((k) => titles.get(k) ?? k).join(', ')}
                  </span>
                ) : (
                  <span className="row" style={{ gap: 4 }}>
                    <Package size={12} /> {t('по вашему запросу')}
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
