import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, CornerDownRight, CornerLeftUp, FolderPlus, Layers, Library, Link2, Puzzle, RefreshCw, Search, Trash2 } from 'lucide-react';
import type { CompatReport, Fix, FomodPrompt, InstalledMod, Issue, Profile } from '../../shared/types';
import { FomodWizard } from '../sheets/FomodWizard';
import { keyOf } from '../../shared/types';
import { api, bridge } from '../api';
import { ago, SOURCE_LABEL } from '../format';
import { useActive, useUI } from '../store';
import { Empty, ModIcon, SevIcon, StatusChip, Switch, sevTone } from '../components/ui';
import { CollectionSheet } from '../sheets/CollectionSheet';
import { RemoveSheet } from '../sheets/RemoveSheet';
import { t } from '../../shared/i18n';

type Filter = 'all' | 'issues' | 'off' | 'deps';

export function issuesFor(report: CompatReport | null, key: string): Issue[] {
  return report?.issues.filter((i) => i.subject === key) ?? [];
}

export function ModStatus({ m, report }: { m: InstalledMod; report: CompatReport | null }) {
  if (!m.enabled) return <StatusChip tone="muted">{t('Выключен')}</StatusChip>;
  const own = issuesFor(report, m.key).filter((i) => i.severity !== 'info');
  const worst = own.find((i) => i.severity === 'error') ?? own[0];
  if (!worst) return <StatusChip tone="ok">{t('Совместим')}</StatusChip>;
  const word: Record<string, string> = {
    'missing-dep': t('Нет зависимости'),
    'disabled-dep': t('Зависимость выкл.'),
    'version-mismatch': t('Не та версия'),
    conflict: t('Конфликт'),
    cycle: t('Цикл порядка'),
    'incompatible-game': t('Не для этой версии'),
    'incompatible-loader': t('Другой загрузчик'),
    'file-conflict': t('Перезапись файлов'),
    'missing-master': t('Нет мастер-файла'),
    duplicate: t('Дубликат'),
  };
  return (
    <StatusChip tone={sevTone(worst.severity)} title={worst.message}>
      {word[worst.code] ?? t('Проблема')}
    </StatusChip>
  );
}

/** Runs a quick fix: some fixes apply at once, others open a plan. */
export async function runFix(profileId: string, fix: Fix) {
  const ui = useUI.getState();
  if (fix.kind === 'install' || fix.kind === 'update' || fix.kind === 'apply-collection') {
    await ui.openPlan(fix.label, () => api.applyFix(profileId, fix));
  } else {
    await ui.run(() => api.applyFix(profileId, fix));
  }
}

export function Mods() {
  const { profile, def } = useActive();
  const report = useUI((s) => s.report);
  const selected = useUI((s) => s.selected);
  const select = useUI((s) => s.select);
  const go = useUI((s) => s.go);
  const openPlan = useUI((s) => s.openPlan);
  const run = useUI((s) => s.run);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [collSheet, setCollSheet] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<{ keys: string[]; all?: boolean } | null>(null);

  const mods = useMemo(() => {
    if (!profile) return [];
    const pos = new Map(report?.order.map((k, i) => [k, i]) ?? []);
    let list = Object.values(profile.mods).sort((a, b) => (pos.get(a.key) ?? 1e9) - (pos.get(b.key) ?? 1e9) || a.title.localeCompare(b.title));
    const text = q.trim().toLowerCase();
    if (text) list = list.filter((m) => `${m.title} ${m.author ?? ''} ${m.ref.projectId}`.toLowerCase().includes(text));
    if (filter === 'issues') list = list.filter((m) => issuesFor(report, m.key).some((i) => i.severity !== 'info'));
    if (filter === 'off') list = list.filter((m) => !m.enabled);
    if (filter === 'deps') list = list.filter((m) => m.reason === 'dependency');
    return list;
  }, [profile, report, q, filter]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!profile || (e.target as HTMLElement).closest('input, textarea, select, [role=dialog]')) return;
      const idx = mods.findIndex((m) => m.key === selected);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = mods[Math.max(0, Math.min(mods.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next) select(next.key);
      } else if (e.key === ' ' && selected && profile.mods[selected]) {
        e.preventDefault();
        void run(() => api.setEnabled(profile.id, selected, !profile.mods[selected].enabled));
      } else if (e.key === 'Escape') select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mods, selected, profile, select, run]);

  if (!profile || !def) return null;
  const total = Object.keys(profile.mods).length;
  const top = (report?.issues ?? []).filter((i) => i.severity !== 'info').slice(0, 4);
  const sel = selected ? profile.mods[selected] : undefined;

  return (
    <div className="content">
      <div className="screen">
        <div className="toolbar">
          <div className="search" style={{ width: 260 }}>
            <Search size={15} />
            <input className="input" placeholder={t("Найти в профиле")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("Поиск по модам профиля")} />
          </div>
          <div className="seg" role="group" aria-label={t("Фильтр")}>
            {(
              [
                ['all', t('Все')],
                ['issues', t('С проблемами')],
                ['deps', t('Зависимости')],
                ['off', t('Выключенные')],
              ] as [Filter, string][]
            ).map(([id, label]) => (
              <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>
                {label}
              </button>
            ))}
          </div>
          <span className="grow" />
          <button className="btn" disabled={total === 0} onClick={() => openPlan(t('Безопасное обновление модов'), () => api.planUpdates(profile.id))} title={t("Обновит только то, что не ломает связи")}>
            <RefreshCw size={15} /> {t('Обновить безопасно')}
          </button>
          <button
            className="btn"
            onClick={async () => {
              const files = await bridge.dialog('files');
              if (files?.length) await openPlan(t('Локальный мод'), () => api.importLocal(profile.id, files));
            }}
          >
            <FolderPlus size={15} /> {t('Локальный мод')}
          </button>
          <button className="btn" disabled={total === 0} onClick={() => setCollSheet(true)}>
            <Library size={15} /> {t('В коллекцию')}
          </button>
          {checked.size > 0 ? (
            <>
              <button className="btn danger" onClick={() => setRemoving({ keys: [...checked] })}>
                <Trash2 size={15} /> {t('Удалить выбранные ({0})', checked.size)}
              </button>
              <button className="btn ghost" onClick={() => setChecked(new Set())}>
                {t('Снять выбор')}
              </button>
            </>
          ) : (
            <button className="btn ghost danger" disabled={total === 0} onClick={() => setRemoving({ keys: Object.keys(profile.mods), all: true })}>
              <Trash2 size={15} /> {t('Удалить все…')}
            </button>
          )}
        </div>

        {top.length > 0 && (
          <div className="issues-strip" role="list" aria-label={t("Проблемы совместимости")}>
            {top.map((i) => (
              <div className="issue-row" role="listitem" key={i.id}>
                <SevIcon s={i.severity} />
                <span className="msg">{i.message}</span>
                {i.fix && (
                  <button className="btn sm" onClick={() => runFix(profile.id, i.fix!)}>
                    {i.fix.label}
                  </button>
                )}
              </div>
            ))}
            {(report?.issues.length ?? 0) > top.length && (
              <button className="issue-row btn ghost" style={{ justifyContent: 'flex-start', borderRadius: 0 }} onClick={() => go('graph')}>
                {t('Все проблемы и граф связей')} <ArrowUpRight size={14} />
              </button>
            )}
          </div>
        )}

        {total === 0 ? (
          <Empty
            icon={<Layers size={32} color="var(--text-3)" />}
            title={t("В профиле пока нет модов")}
            text={t("Найдите моды в обзоре — Lattice сам подтянет зависимости и проверит, что всё совместимо с этой версией игры.")}
            action={
              <button className="btn primary" onClick={() => go('discover')}>
                {t('Открыть обзор')}
              </button>
            }
          />
        ) : (
          <div className="screen-scroll" style={{ padding: '12px 24px 32px' }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <input
                      type="checkbox"
                      aria-label={t("Выбрать все моды в списке")}
                      checked={mods.length > 0 && mods.every((m) => checked.has(m.key))}
                      onChange={(e) => setChecked(e.target.checked ? new Set([...checked, ...mods.map((m) => m.key)]) : new Set([...checked].filter((k) => !mods.some((m) => m.key === k))))}
                    />
                  </th>
                  <th style={{ width: 44 }}>
                    <span className="sr-only">{t('Включён')}</span>
                  </th>
                  <th>{t('Мод')}</th>
                  <th>{t('Версия')}</th>
                  <th>{t('Источник')}</th>
                  <th>{t('Связи')}</th>
                  <th>{t('Статус')}</th>
                </tr>
              </thead>
              <tbody>
                {mods.map((m) => (
                  <ModRow
                    key={m.key}
                    m={m}
                    profile={profile}
                    report={report}
                    selected={m.key === selected}
                    checked={checked.has(m.key)}
                    onCheck={(v) => {
                      const next = new Set(checked);
                      if (v) next.add(m.key);
                      else next.delete(m.key);
                      setChecked(next);
                    }}
                    onSelect={() => select(m.key === selected ? null : m.key)}
                  />
                ))}
              </tbody>
            </table>
            {mods.length === 0 && <p className="muted" style={{ padding: 16 }}>{t('Под фильтр ничего не подходит.')}</p>}
          </div>
        )}
      </div>
      {sel && <ModInspector m={sel} profile={profile} report={report} onRemove={() => setRemoving({ keys: [sel.key] })} />}
      {removing && (
        <RemoveSheet
          profileId={profile.id}
          keys={removing.keys}
          all={removing.all}
          onClose={() => {
            setRemoving(null);
            setChecked(new Set());
          }}
        />
      )}
      {collSheet && <CollectionSheet profileId={profile.id} onClose={() => setCollSheet(false)} />}
    </div>
  );
}

function ModRow({
  m,
  profile,
  report,
  selected,
  checked,
  onCheck,
  onSelect,
}: {
  m: InstalledMod;
  profile: Profile;
  report: CompatReport | null;
  selected: boolean;
  checked: boolean;
  onCheck: (v: boolean) => void;
  onSelect: () => void;
}) {
  const run = useUI((s) => s.run);
  const requires = m.deps.filter((d) => d.kind === 'requires').length;
  const dependents = report?.dependents[m.key]?.length ?? 0;
  const broken = issuesFor(report, m.key).some((i) => ['missing-dep', 'disabled-dep', 'version-mismatch'].includes(i.code));
  const inColl = m.requiredBy.filter((r) => r.startsWith('collection:')).length;
  return (
    <tr aria-selected={selected} className={m.enabled ? '' : 'disabled'} onClick={onSelect}>
      <td onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={checked} aria-label={t('Выбрать «{0}»', m.title)} onChange={(e) => onCheck(e.target.checked)} />
      </td>
      <td>
        <Switch on={m.enabled} label={t('Включить «{0}»', m.title)} onChange={(v) => run(() => api.setEnabled(profile.id, m.key, v))} />
      </td>
      <td style={{ maxWidth: 360 }}>
        <div className="mod-cell">
          <ModIcon url={m.iconUrl} title={m.title} />
          <div className="mod-name">
            <b className="ellipsis">{m.title}</b>
            <small className="ellipsis">
              {m.reason === 'dependency' ? t('зависимость') : m.reason === 'collection' ? t('из коллекции') : (m.author ?? t('установлен вами'))}
            </small>
          </div>
        </div>
      </td>
      <td className="mono">{m.version}</td>
      <td>
        <span className="chip outline">{SOURCE_LABEL[m.ref.source]}</span>
      </td>
      <td>
        <span className="links">
          <span className={`link-pill ${broken ? 'broken' : requires ? '' : 'zero'}`} title={t('Требует: {0}', requires)}>
            <CornerDownRight size={12} />
            {requires}
          </span>
          <span className={`link-pill ${dependents ? '' : 'zero'}`} title={t('Нужен для: {0}', dependents)}>
            <CornerLeftUp size={12} />
            {dependents}
          </span>
          {inColl > 0 && (
            <span className="link-pill" title={t("Входит в коллекции")}>
              <Library size={12} />
              {inColl}
            </span>
          )}
        </span>
      </td>
      <td>
        <ModStatus m={m} report={report} />
      </td>
    </tr>
  );
}

function ModInspector({ m, profile, report, onRemove }: { m: InstalledMod; profile: Profile; report: CompatReport | null; onRemove: () => void }) {
  const { state } = useActive();
  const select = useUI((s) => s.select);
  const run = useUI((s) => s.run);
  const openPlan = useUI((s) => s.openPlan);
  const [ruleOther, setRuleOther] = useState('');
  const [ruleKind, setRuleKind] = useState<'after' | 'before'>('after');
  const [linkOther, setLinkOther] = useState('');
  const [linkKind, setLinkKind] = useState<'requires' | 'conflicts'>('requires');
  const [fomod, setFomod] = useState<FomodPrompt | null>(null);

  const title = (k: string) => profile.mods[k]?.title ?? k.split(':').slice(1).join(':');
  const own = report?.issues.filter((i) => i.subject === m.key || i.related.includes(m.key)) ?? [];
  const dependents = report?.dependents[m.key] ?? [];
  const groups = [
    { label: t('Требует'), kinds: ['requires'] },
    { label: t('Рекомендует'), kinds: ['recommends', 'optional'] },
    { label: t('Несовместим с'), kinds: ['conflicts'] },
  ];
  const collections = m.requiredBy.filter((r) => r.startsWith('collection:')).map((r) => state?.collections.find((c) => c.id === r.slice(11))?.name ?? r.slice(11));
  const rules = profile.rules.filter((r) => r.subject === m.key || r.other === m.key);
  const others = Object.values(profile.mods).filter((x) => x.key !== m.key);

  return (
    <aside className="inspector" aria-label={t('Мод {0}', m.title)}>
      <div className="inspector-head">
        <ModIcon url={m.iconUrl} title={m.title} size="lg" />
        <div className="grow" style={{ minWidth: 0 }}>
          <h2 className="ellipsis">{m.title}</h2>
          <div className="row" style={{ marginTop: 4, flexWrap: 'wrap' }}>
            <span className="chip outline">{SOURCE_LABEL[m.ref.source]}</span>
            <span className="mono muted">{m.version}</span>
            <ModStatus m={m} report={report} />
          </div>
        </div>
      </div>
      <div className="inspector-body">
        {own.length > 0 && (
          <div className="issues-strip" style={{ margin: 0 }}>
            {own.map((i) => (
              <div className="issue-row" key={i.id}>
                <SevIcon s={i.severity} />
                <span className="msg" style={{ fontSize: 'var(--fs-sm)' }}>
                  {i.message}
                </span>
                {i.fix && (
                  <button className="btn sm" onClick={() => runFix(profile.id, i.fix!)}>
                    {t('Исправить')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {groups.map((g) => {
          const deps = m.deps.filter((d) => g.kinds.includes(d.kind));
          if (deps.length === 0 && g.label !== t('Требует')) return null;
          return (
            <div className="col" key={g.label}>
              <span className="label">
                {g.label} · {deps.length}
              </span>
              {deps.length === 0 ? (
                <span className="faint">{t('Ничего — мод самодостаточен.')}</span>
              ) : (
                <div className="link-list">
                  {deps.map((d) => {
                    const k = keyOf(d.ref);
                    const target = profile.mods[k];
                    const tone = d.kind === 'conflicts' ? (target?.enabled ? 'err' : 'ok') : target ? (target.enabled ? 'ok' : 'warn') : d.kind === 'requires' ? 'err' : 'muted';
                    const word = d.kind === 'conflicts' ? (target?.enabled ? t('Включён') : t('Нет')) : target ? (target.enabled ? t('Есть') : t('Выключен')) : t('Нет');
                    return (
                      <div className="link-item" key={k + d.kind}>
                        <span className="grow ellipsis" onClick={() => target && select(k)} title={target ? t('Перейти') : undefined}>
                          {target?.title ?? d.name ?? d.ref.projectId}
                          {d.range && <span className="mono faint"> {d.range}</span>}
                          {d.user && <span className="faint"> · {t('вручную')}</span>}
                        </span>
                        <StatusChip tone={tone}>{word}</StatusChip>
                        {d.user && (
                          <button className="btn ghost sm icon" aria-label={t("Убрать связь")} onClick={() => run(() => api.setUserLink(profile.id, m.key, null, k))}>
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        <div className="col">
          <span className="label">{t('Нужен для ·')} {dependents.length}</span>
          {dependents.length === 0 ? (
            <span className="faint">{m.reason === 'dependency' ? t('Больше никому не нужен — удалится при очистке.') : t('Ни один мод на него не опирается.')}</span>
          ) : (
            <div className="link-list">
              {dependents.map((k) => (
                <div className="link-item" key={k}>
                  <span className="grow ellipsis" onClick={() => select(k)}>
                    {title(k)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {collections.length > 0 && <span className="muted">{t('Входит в коллекции:')} {collections.map((c) => `«${c}»`).join(', ')}</span>}
        </div>

        <div className="col">
          <span className="label">{t('Порядок загрузки')}</span>
          {rules.map((r) => (
            <div className="link-item" key={`${r.subject}${r.kind}${r.other}`}>
              <span className="grow ellipsis">
                {r.kind === 'after' ? t('«{0}» после «{1}»', title(r.subject), title(r.other)) : t('«{0}» до «{1}»', title(r.subject), title(r.other))}
              </span>
              <button className="btn ghost sm icon" aria-label={t("Удалить правило")} onClick={() => run(() => api.removeRule(profile.id, r))}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <div className="row">
            <select className="select" style={{ width: 90 }} value={ruleKind} onChange={(e) => setRuleKind(e.target.value as 'after' | 'before')} aria-label={t("Тип правила")}>
              <option value="after">{t('после')}</option>
              <option value="before">{t('до')}</option>
            </select>
            <select className="select grow" value={ruleOther} onChange={(e) => setRuleOther(e.target.value)} aria-label={t("Другой мод")}>
              <option value="">{t('выберите мод…')}</option>
              {others.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.title}
                </option>
              ))}
            </select>
            <button
              className="btn sm"
              disabled={!ruleOther}
              onClick={() => {
                void run(() => api.addRule(profile.id, { subject: m.key, kind: ruleKind, other: ruleOther }));
                setRuleOther('');
              }}
            >
              {t('Добавить')}
            </button>
          </div>
        </div>

        <div className="col">
          <span className="label">{t('Своя связь')}</span>
          <span className="faint" style={{ fontSize: 'var(--fs-sm)' }}>
            {t('Если источник не указал зависимость — задайте её сами. Связь сохранится при обновлениях.')}
          </span>
          <div className="row">
            <select className="select" style={{ width: 120 }} value={linkKind} onChange={(e) => setLinkKind(e.target.value as 'requires' | 'conflicts')} aria-label={t("Тип связи")}>
              <option value="requires">{t('требует')}</option>
              <option value="conflicts">{t('конфликтует')}</option>
            </select>
            <select className="select grow" value={linkOther} onChange={(e) => setLinkOther(e.target.value)} aria-label={t("Мод для связи")}>
              <option value="">{t('выберите мод…')}</option>
              {others.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.title}
                </option>
              ))}
            </select>
            <button
              className="btn sm"
              disabled={!linkOther}
              onClick={() => {
                const o = profile.mods[linkOther];
                void run(() => api.setUserLink(profile.id, m.key, { ref: o.ref, kind: linkKind, name: o.title }));
                setLinkOther('');
              }}
            >
              <Link2 size={13} />
            </button>
          </div>
        </div>

        <dl className="kv">
          <dt>{t('Версии игры')}</dt>
          <dd className="mono">{m.gameVersions.length ? m.gameVersions.slice(-6).join(', ') : t('не указаны')}</dd>
          <dt>{t('Загрузчики')}</dt>
          <dd>{m.loaders.length ? m.loaders.join(', ') : '—'}</dd>
          <dt>{t('Установлен')}</dt>
          <dd>{ago(m.installedAt)}</dd>
          <dt>{t('Причина')}</dt>
          <dd>{m.reason === 'explicit' ? t('вы выбрали') : m.reason === 'dependency' ? t('зависимость') : t('коллекция')}</dd>
          <dt>ID</dt>
          <dd className="mono">{m.ref.projectId}</dd>
        </dl>
      </div>
      <div className="inspector-foot">
        {m.ref.source !== 'local' && (
          <button className="btn" onClick={() => openPlan(t('Обновление «{0}»', m.title), () => api.planUpdates(profile.id, [m.key]))}>
            <RefreshCw size={14} /> {t('Обновить')}
          </button>
        )}
        <button className="btn" onClick={() => run(() => api.setEnabled(profile.id, m.key, !m.enabled))}>
          {m.enabled ? t('Выключить') : t('Включить')}
        </button>
        {m.choices && (
          <button
            className="btn"
            title={t("Пройти установщик FOMOD заново")}
            onClick={async () => {
              const p = await run(() => api.fomodPrompt(profile.id, m.key));
              if (p) setFomod(p);
            }}
          >
            <Puzzle size={14} /> {t('Опции')}
          </button>
        )}
        <span className="grow" />
        <button className="btn danger" onClick={onRemove}>
          <Trash2 size={14} /> {t('Удалить')}
        </button>
      </div>
      {fomod && (
        <FomodWizard
          prompts={[fomod]}
          onCancel={() => setFomod(null)}
          onDone={(c) => {
            setFomod(null);
            void run(() => api.reinstallWithChoices(profile.id, m.key, c[m.key]));
          }}
        />
      )}
    </aside>
  );
}
