import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, CornerDownRight, CornerLeftUp, FolderPlus, Layers, Library, Link2, Puzzle, RefreshCw, Search, Trash2 } from 'lucide-react';
import type { CompatReport, Fix, FomodPrompt, InstalledMod, Issue, Profile } from '../../shared/types';
import { FomodWizard } from '../sheets/FomodWizard';
import { keyOf } from '../../shared/types';
import { api, bridge } from '../api';
import { ago, plural, SOURCE_LABEL } from '../format';
import { useActive, useUI } from '../store';
import { Empty, ModIcon, Modal, SevIcon, StatusChip, Switch, sevTone } from '../components/ui';
import { CollectionSheet } from '../sheets/CollectionSheet';

type Filter = 'all' | 'issues' | 'off' | 'deps';

export function issuesFor(report: CompatReport | null, key: string): Issue[] {
  return report?.issues.filter((i) => i.subject === key) ?? [];
}

export function ModStatus({ m, report }: { m: InstalledMod; report: CompatReport | null }) {
  if (!m.enabled) return <StatusChip tone="muted">Выключен</StatusChip>;
  const own = issuesFor(report, m.key).filter((i) => i.severity !== 'info');
  const worst = own.find((i) => i.severity === 'error') ?? own[0];
  if (!worst) return <StatusChip tone="ok">Совместим</StatusChip>;
  const word: Record<string, string> = {
    'missing-dep': 'Нет зависимости',
    'disabled-dep': 'Зависимость выкл.',
    'version-mismatch': 'Не та версия',
    conflict: 'Конфликт',
    cycle: 'Цикл порядка',
    'incompatible-game': 'Не для этой версии',
    'incompatible-loader': 'Другой загрузчик',
    'file-conflict': 'Перезапись файлов',
    'missing-master': 'Нет мастер-файла',
  };
  return (
    <StatusChip tone={sevTone(worst.severity)} title={worst.message}>
      {word[worst.code] ?? 'Проблема'}
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
            <input className="input" placeholder="Найти в профиле" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск по модам профиля" />
          </div>
          <div className="seg" role="group" aria-label="Фильтр">
            {(
              [
                ['all', 'Все'],
                ['issues', 'С проблемами'],
                ['deps', 'Зависимости'],
                ['off', 'Выключенные'],
              ] as [Filter, string][]
            ).map(([id, label]) => (
              <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>
                {label}
              </button>
            ))}
          </div>
          <span className="grow" />
          <button className="btn" disabled={total === 0} onClick={() => openPlan('Безопасное обновление модов', () => api.planUpdates(profile.id))} title="Обновит только то, что не ломает связи">
            <RefreshCw size={15} /> Обновить безопасно
          </button>
          <button
            className="btn"
            onClick={async () => {
              const files = await bridge.dialog('files');
              if (files?.length) await openPlan('Локальный мод', () => api.importLocal(profile.id, files));
            }}
          >
            <FolderPlus size={15} /> Локальный мод
          </button>
          <button className="btn" disabled={total === 0} onClick={() => setCollSheet(true)}>
            <Library size={15} /> В коллекцию
          </button>
        </div>

        {top.length > 0 && (
          <div className="issues-strip" role="list" aria-label="Проблемы совместимости">
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
                Все проблемы и граф связей <ArrowUpRight size={14} />
              </button>
            )}
          </div>
        )}

        {total === 0 ? (
          <Empty
            icon={<Layers size={32} color="var(--text-3)" />}
            title="В профиле пока нет модов"
            text="Найдите моды в обзоре — Lattice сам подтянет зависимости и проверит, что всё совместимо с этой версией игры."
            action={
              <button className="btn primary" onClick={() => go('discover')}>
                Открыть обзор
              </button>
            }
          />
        ) : (
          <div className="screen-scroll" style={{ padding: '12px 24px 32px' }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 44 }}>
                    <span className="sr-only">Включён</span>
                  </th>
                  <th>Мод</th>
                  <th>Версия</th>
                  <th>Источник</th>
                  <th>Связи</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {mods.map((m) => (
                  <ModRow key={m.key} m={m} profile={profile} report={report} selected={m.key === selected} onSelect={() => select(m.key === selected ? null : m.key)} />
                ))}
              </tbody>
            </table>
            {mods.length === 0 && <p className="muted" style={{ padding: 16 }}>Под фильтр ничего не подходит.</p>}
          </div>
        )}
      </div>
      {sel && <ModInspector m={sel} profile={profile} report={report} />}
      {collSheet && <CollectionSheet profileId={profile.id} onClose={() => setCollSheet(false)} />}
    </div>
  );
}

function ModRow({ m, profile, report, selected, onSelect }: { m: InstalledMod; profile: Profile; report: CompatReport | null; selected: boolean; onSelect: () => void }) {
  const run = useUI((s) => s.run);
  const requires = m.deps.filter((d) => d.kind === 'requires').length;
  const dependents = report?.dependents[m.key]?.length ?? 0;
  const broken = issuesFor(report, m.key).some((i) => ['missing-dep', 'disabled-dep', 'version-mismatch'].includes(i.code));
  const inColl = m.requiredBy.filter((r) => r.startsWith('collection:')).length;
  return (
    <tr aria-selected={selected} className={m.enabled ? '' : 'disabled'} onClick={onSelect}>
      <td>
        <Switch on={m.enabled} label={`Включить «${m.title}»`} onChange={(v) => run(() => api.setEnabled(profile.id, m.key, v))} />
      </td>
      <td style={{ maxWidth: 360 }}>
        <div className="mod-cell">
          <ModIcon url={m.iconUrl} title={m.title} />
          <div className="mod-name">
            <b className="ellipsis">{m.title}</b>
            <small className="ellipsis">
              {m.reason === 'dependency' ? 'зависимость' : m.reason === 'collection' ? 'из коллекции' : (m.author ?? 'установлен вами')}
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
          <span className={`link-pill ${broken ? 'broken' : requires ? '' : 'zero'}`} title={`Требует: ${requires}`}>
            <CornerDownRight size={12} />
            {requires}
          </span>
          <span className={`link-pill ${dependents ? '' : 'zero'}`} title={`Нужен для: ${dependents}`}>
            <CornerLeftUp size={12} />
            {dependents}
          </span>
          {inColl > 0 && (
            <span className="link-pill" title="Входит в коллекции">
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

function ModInspector({ m, profile, report }: { m: InstalledMod; profile: Profile; report: CompatReport | null }) {
  const { state } = useActive();
  const select = useUI((s) => s.select);
  const run = useUI((s) => s.run);
  const openPlan = useUI((s) => s.openPlan);
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [ruleOther, setRuleOther] = useState('');
  const [ruleKind, setRuleKind] = useState<'after' | 'before'>('after');
  const [linkOther, setLinkOther] = useState('');
  const [linkKind, setLinkKind] = useState<'requires' | 'conflicts'>('requires');
  const [fomod, setFomod] = useState<FomodPrompt | null>(null);

  const title = (k: string) => profile.mods[k]?.title ?? k.split(':').slice(1).join(':');
  const own = report?.issues.filter((i) => i.subject === m.key || i.related.includes(m.key)) ?? [];
  const dependents = report?.dependents[m.key] ?? [];
  const groups = [
    { label: 'Требует', kinds: ['requires'] },
    { label: 'Рекомендует', kinds: ['recommends', 'optional'] },
    { label: 'Несовместим с', kinds: ['conflicts'] },
  ];
  const collections = m.requiredBy.filter((r) => r.startsWith('collection:')).map((r) => state?.collections.find((c) => c.id === r.slice(11))?.name ?? r.slice(11));
  const rules = profile.rules.filter((r) => r.subject === m.key || r.other === m.key);
  const others = Object.values(profile.mods).filter((x) => x.key !== m.key);

  const remove = async (cascade: boolean) => {
    const res = await run(() => api.removeMod(profile.id, m.key, cascade));
    if (!res) return;
    if (res.blockedBy.length) return setConfirm(res.blockedBy);
    setConfirm(null);
    select(null);
    useUI.getState().toast('ok', `Удалено: ${plural(res.removed.length, 'мод', 'мода', 'модов')}${res.removed.length > 1 ? ' (вместе с ненужными зависимостями)' : ''}`);
  };

  return (
    <aside className="inspector" aria-label={`Мод ${m.title}`}>
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
                    Исправить
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {groups.map((g) => {
          const deps = m.deps.filter((d) => g.kinds.includes(d.kind));
          if (deps.length === 0 && g.label !== 'Требует') return null;
          return (
            <div className="col" key={g.label}>
              <span className="label">
                {g.label} · {deps.length}
              </span>
              {deps.length === 0 ? (
                <span className="faint">Ничего — мод самодостаточен.</span>
              ) : (
                <div className="link-list">
                  {deps.map((d) => {
                    const k = keyOf(d.ref);
                    const target = profile.mods[k];
                    const tone = d.kind === 'conflicts' ? (target?.enabled ? 'err' : 'ok') : target ? (target.enabled ? 'ok' : 'warn') : d.kind === 'requires' ? 'err' : 'muted';
                    const word = d.kind === 'conflicts' ? (target?.enabled ? 'Включён' : 'Нет') : target ? (target.enabled ? 'Есть' : 'Выключен') : 'Нет';
                    return (
                      <div className="link-item" key={k + d.kind}>
                        <span className="grow ellipsis" onClick={() => target && select(k)} title={target ? 'Перейти' : undefined}>
                          {target?.title ?? d.name ?? d.ref.projectId}
                          {d.range && <span className="mono faint"> {d.range}</span>}
                          {d.user && <span className="faint"> · вручную</span>}
                        </span>
                        <StatusChip tone={tone}>{word}</StatusChip>
                        {d.user && (
                          <button className="btn ghost sm icon" aria-label="Убрать связь" onClick={() => run(() => api.setUserLink(profile.id, m.key, null, k))}>
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
          <span className="label">Нужен для · {dependents.length}</span>
          {dependents.length === 0 ? (
            <span className="faint">{m.reason === 'dependency' ? 'Больше никому не нужен — удалится при очистке.' : 'Ни один мод на него не опирается.'}</span>
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
          {collections.length > 0 && <span className="muted">Входит в коллекции: {collections.map((c) => `«${c}»`).join(', ')}</span>}
        </div>

        <div className="col">
          <span className="label">Порядок загрузки</span>
          {rules.map((r) => (
            <div className="link-item" key={`${r.subject}${r.kind}${r.other}`}>
              <span className="grow ellipsis">
                «{title(r.subject)}» {r.kind === 'after' ? 'после' : 'до'} «{title(r.other)}»
              </span>
              <button className="btn ghost sm icon" aria-label="Удалить правило" onClick={() => run(() => api.removeRule(profile.id, r))}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <div className="row">
            <select className="select" style={{ width: 90 }} value={ruleKind} onChange={(e) => setRuleKind(e.target.value as 'after' | 'before')} aria-label="Тип правила">
              <option value="after">после</option>
              <option value="before">до</option>
            </select>
            <select className="select grow" value={ruleOther} onChange={(e) => setRuleOther(e.target.value)} aria-label="Другой мод">
              <option value="">выберите мод…</option>
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
              Добавить
            </button>
          </div>
        </div>

        <div className="col">
          <span className="label">Своя связь</span>
          <span className="faint" style={{ fontSize: 'var(--fs-sm)' }}>
            Если источник не указал зависимость — задайте её сами. Связь сохранится при обновлениях.
          </span>
          <div className="row">
            <select className="select" style={{ width: 120 }} value={linkKind} onChange={(e) => setLinkKind(e.target.value as 'requires' | 'conflicts')} aria-label="Тип связи">
              <option value="requires">требует</option>
              <option value="conflicts">конфликтует</option>
            </select>
            <select className="select grow" value={linkOther} onChange={(e) => setLinkOther(e.target.value)} aria-label="Мод для связи">
              <option value="">выберите мод…</option>
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
          <dt>Версии игры</dt>
          <dd className="mono">{m.gameVersions.length ? m.gameVersions.slice(-6).join(', ') : 'не указаны'}</dd>
          <dt>Загрузчики</dt>
          <dd>{m.loaders.length ? m.loaders.join(', ') : '—'}</dd>
          <dt>Установлен</dt>
          <dd>{ago(m.installedAt)}</dd>
          <dt>Причина</dt>
          <dd>{m.reason === 'explicit' ? 'вы выбрали' : m.reason === 'dependency' ? 'зависимость' : 'коллекция'}</dd>
          <dt>ID</dt>
          <dd className="mono">{m.ref.projectId}</dd>
        </dl>
      </div>
      <div className="inspector-foot">
        {m.ref.source !== 'local' && (
          <button className="btn" onClick={() => openPlan(`Обновление «${m.title}»`, () => api.planUpdates(profile.id, [m.key]))}>
            <RefreshCw size={14} /> Обновить
          </button>
        )}
        <button className="btn" onClick={() => run(() => api.setEnabled(profile.id, m.key, !m.enabled))}>
          {m.enabled ? 'Выключить' : 'Включить'}
        </button>
        {m.choices && (
          <button
            className="btn"
            title="Пройти установщик FOMOD заново"
            onClick={async () => {
              const p = await run(() => api.fomodPrompt(profile.id, m.key));
              if (p) setFomod(p);
            }}
          >
            <Puzzle size={14} /> Опции
          </button>
        )}
        <span className="grow" />
        <button className="btn danger" onClick={() => remove(false)}>
          <Trash2 size={14} /> Удалить
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
      {confirm && (
        <Modal
          title={`Удалить «${m.title}»?`}
          sub="На него опираются другие моды. Без него они не запустятся."
          size="sm"
          onClose={() => setConfirm(null)}
          foot={
            <>
              <span className="grow" />
              <button className="btn ghost" onClick={() => setConfirm(null)}>
                Отмена
              </button>
              <button className="btn danger" onClick={() => remove(true)}>
                Удалить вместе с зависимыми ({confirm.length + 1})
              </button>
            </>
          }
        >
          <div className="link-list">
            {confirm.map((k) => (
              <div className="link-item" key={k}>
                <CornerLeftUp size={14} /> {title(k)}
              </div>
            ))}
          </div>
        </Modal>
      )}
    </aside>
  );
}
