import { useEffect, useState } from 'react';
import { ArrowRightLeft, ArrowUpRight, CircleCheck, ClipboardList, Compass, FileText, Gamepad2, HardDrive, History, Layers, Library, Network, RefreshCw, ShieldCheck, TriangleAlert, Upload } from 'lucide-react';
import type { HealthProblem, Issue } from '../../shared/types';
import { api, bridge } from '../api';
import { ago, bytes, LOADER_LABEL, plural } from '../format';
import { useActive, useUI } from '../store';
import { HealthRing, SevIcon, Spinner } from '../components/ui';
import { ImportSheet } from '../sheets/ImportSheet';
import { runFix } from './Mods';
import { t } from '../../shared/i18n';

/** What a problem is about, for the line under its text. */
function subjectName(i: Issue, title: (k: string) => string): string {
  if (i.subject.startsWith('game:')) return t('игра');
  if (i.subject.startsWith('collection:')) return t('коллекция');
  return title(i.subject);
}

/** "3 мода" with the number set in bold: the word keeps the form the number asks for. */
function counted(text: string) {
  const at = text.indexOf(' ');
  return (
    <>
      <b>{text.slice(0, at)}</b> {text.slice(at + 1)}
    </>
  );
}

/**
 * The state of the build on one screen: is it healthy, what did the game say on
 * its last run, what is there to fix — each with the button that fixes it.
 */
export function Home() {
  const { profile, game, def, state } = useActive();
  const report = useUI((s) => s.report);
  const go = useUI((s) => s.go);
  const select = useUI((s) => s.select);
  const run = useUI((s) => s.run);
  const [health, setHealth] = useState<HealthProblem[] | null>(null);
  const [fixing, setFixing] = useState(false);
  const [disk, setDisk] = useState<Awaited<ReturnType<typeof api.diskUsage>> | null>(null);
  const [moving, setMoving] = useState(false);
  const loadHealth = () =>
    api
      .healthCheck()
      .then(setHealth)
      .catch(() => setHealth([]));
  useEffect(() => {
    setHealth(null);
    void loadHealth();
    void api
      .diskUsage()
      .then(setDisk)
      .catch(() => setDisk(null));
  }, [profile?.id, profile?.deployedAt, state?.games.length]);
  if (!profile || !game || !def || !state) return null;

  const mods = Object.values(profile.mods);
  const on = mods.filter((m) => m.enabled).length;
  const title = (k: string) => profile.mods[k]?.title ?? report?.names?.[k] ?? k.split(':').slice(1).join(':');
  const issues = report?.issues ?? [];
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const notes = issues.filter((i) => i.severity === 'info');
  const log = report?.log;
  const collections = state.collections.filter((c) => c.game.defId === def.id);
  const snapshots = state.snapshots.filter((s) => s.profileId === profile.id);
  const fixable = (health ?? []).filter((h) => h.fixable);
  const headline = !report
    ? t('Проверяем сборку…')
    : errors.length
      ? t('Сборку нужно поправить')
      : warnings.length
        ? t('Сборка работает, есть замечания')
        : mods.length
          ? t('Сборка цела')
          : t('Профиль пуст');
  const sub = !report
    ? ''
    : errors.length
      ? t('{0}: с ними часть модов не заработает или игра не запустится.', plural(errors.length, 'ошибка', 'ошибки', 'ошибок'))
      : warnings.length
        ? t('{0}: игра запустится, но на них стоит взглянуть.', plural(warnings.length, 'замечание', 'замечания', 'замечаний'))
        : mods.length
          ? t('Все связи между модами сходятся, файлы лежат там, где игра их читает.')
          : t('Найдите моды в «Обзоре», примените коллекцию или перенесите сборку из другого менеджера.');

  const row = (i: Issue) => (
    <div className="issue-row" key={i.id}>
      <SevIcon s={i.severity} />
      <span className="msg">
        {i.message}
        <br />
        <button
          className="text-link faint"
          style={{ fontSize: 'var(--fs-sm)' }}
          disabled={!profile.mods[i.subject]}
          onClick={() => {
            select(i.subject);
            go('mods');
          }}
        >
          {subjectName(i, title)}
        </button>
      </span>
      {i.fix && (
        <button className="btn sm" onClick={() => runFix(profile.id, i.fix!)}>
          {i.fix.label}
        </button>
      )}
    </div>
  );

  return (
    <div className="content">
      <div className="screen">
        <div className="screen-scroll">
          <div className="home">
            <section className="card home-hero">
              <HealthRing score={report?.score ?? null} size={84} />
              <div className="col grow" style={{ gap: 6, minWidth: 0 }}>
                <h2>{headline}</h2>
                <span className="muted">{sub}</span>
                <div className="row" style={{ flexWrap: 'wrap', marginTop: 4 }}>
                  <span className="chip">
                    <Layers size={12} /> {plural(mods.length, 'мод', 'мода', 'модов')}
                    {on !== mods.length ? t(', включено {0}', on) : ''}
                  </span>
                  {def.kind === 'minecraft' && (
                    <span className="chip outline mono">
                      {profile.context.gameVersion ?? t('любая')} · {LOADER_LABEL[profile.context.loader ?? ''] ?? profile.context.loader ?? '—'}
                    </span>
                  )}
                  <span className="chip outline">{profile.deployedAt ? t('Применено к игре {0}', ago(profile.deployedAt)) : t('Ещё не применено к игре')}</span>
                </div>
              </div>
            </section>

            <section className="card card-pad col">
              <span className="label">{t('Последний запуск игры')}</span>
              {!log ? (
                <span className="muted">{t('Журнал игры не найден. После первого запуска с модами Lattice прочитает его и покажет, какие моды игра действительно загрузила.')}</span>
              ) : log.stale ? (
                <span className="row muted" style={{ alignItems: 'flex-start' }}>
                  <History size={16} style={{ flex: 'none', marginTop: 2 }} />
                  {t('После последних изменений игра ещё не запускалась (журнал от {0}). Запустите её — Lattice проверит по журналу, что моды загрузились.', ago(log.at))}
                </span>
              ) : (
                <span className="row" style={{ alignItems: 'flex-start' }}>
                  {log.fatal || log.failed ? <TriangleAlert size={16} className="sev-err" style={{ flex: 'none', marginTop: 2 }} /> : <CircleCheck size={16} className="sev-ok" style={{ flex: 'none', marginTop: 2 }} />}
                  <span>
                    <b>
                      {log.loaders.join(' + ')} · {ago(log.at)}
                    </b>
                    <br />
                    <span className="muted">
                      {log.fatal ?? (log.failed ? t('Загружено модов: {0}, не загрузилось: {1}. Причины — в списке ниже.', log.loaded, log.failed) : t('Загружено модов: {0}. Игра не сообщила ни об одном отказе.', log.loaded))}
                    </span>
                  </span>
                </span>
              )}
            </section>

            <section className="col home-main">
              <span className="label">
                {t('Что исправить')} · {errors.length + warnings.length}
              </span>
              {!report ? (
                <Spinner />
              ) : errors.length + warnings.length === 0 ? (
                <div className="card card-pad row muted">
                  <CircleCheck size={18} className="sev-ok" /> {t('Проблем не найдено.')}
                </div>
              ) : (
                <div className="issues-strip" style={{ margin: 0 }}>
                  {errors.map(row)}
                  {warnings.map(row)}
                </div>
              )}
              {notes.length > 0 && (
                <details className="home-notes">
                  <summary className="muted">{t('Заметки, которые ничего не ломают ({0})', notes.length)}</summary>
                  <div className="issues-strip" style={{ margin: '8px 0 0' }}>
                    {notes.map(row)}
                  </div>
                </details>
              )}
              <button className="btn ghost" style={{ alignSelf: 'flex-start' }} onClick={() => go('graph')}>
                <Network size={15} /> {t('Открыть граф связей')} <ArrowUpRight size={13} />
              </button>
            </section>

            <aside className="col home-side">
              <section className="card card-pad col">
                <span className="label">{t('Целостность')}</span>
                {!health ? (
                  <Spinner />
                ) : health.length === 0 ? (
                  <span className="row muted">
                    <ShieldCheck size={16} className="sev-ok" /> {t('Файлы модов, папки игр и кэш в порядке.')}
                  </span>
                ) : (
                  <>
                    {health.map((h) => (
                      <span key={h.id} className="row" style={{ alignItems: 'flex-start' }}>
                        <TriangleAlert size={15} className={h.fixable ? 'sev-warn' : 'sev-info'} style={{ flex: 'none', marginTop: 2 }} />
                        <span>
                          <b>{h.title}</b>
                          <br />
                          <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
                            {h.detail}
                          </span>
                        </span>
                      </span>
                    ))}
                    {fixable.length > 0 && (
                      <button
                        className="btn primary sm"
                        style={{ alignSelf: 'flex-start' }}
                        disabled={fixing}
                        onClick={async () => {
                          setFixing(true);
                          const r = await run(() => api.repair(fixable.map((h) => h.id)));
                          setFixing(false);
                          if (r?.failed.length) useUI.getState().toast('err', t('Не всё удалось исправить:\n{0}', r.failed.map((f) => f.error).join('\n')));
                          else if (r) useUI.getState().toast('ok', t('Исправлено: {0}', r.fixed.length));
                          void loadHealth();
                        }}
                      >
                        {fixing && <Spinner />} {t('Попытаться исправить ({0})', fixable.length)}
                      </button>
                    )}
                  </>
                )}
              </section>

              <section className="card card-pad col">
                <span className="label">{t('В этой игре')}</span>
                <div className="home-stats">
                  <button onClick={() => go('mods')}>
                    <Layers size={15} /> {counted(plural(mods.length, 'мод', 'мода', 'модов'))}
                  </button>
                  <button onClick={() => go('collections')}>
                    <Library size={15} /> {counted(plural(collections.length, 'коллекция', 'коллекции', 'коллекций'))}
                  </button>
                  <button onClick={() => go('snapshots')}>
                    <History size={15} /> {counted(plural(snapshots.length, 'снимок', 'снимка', 'снимков'))}
                  </button>
                  <button onClick={() => go('settings')} title={t('Скачанные файлы и подготовленные копии модов')}>
                    <HardDrive size={15} /> <b>{disk ? bytes(disk.downloads + disk.staging) : '…'}</b> {t('на диске')}
                  </button>
                </div>
              </section>

              <section className="card card-pad col">
                <span className="label">{t('Быстрые действия')}</span>
                <div className="home-actions">
                  <button className="btn" onClick={() => go('discover')}>
                    <Compass size={15} /> {t('Найти моды')}
                  </button>
                  <button className="btn" onClick={() => setMoving(true)}>
                    <ArrowRightLeft size={15} /> {t('Перенести из Vortex, MO2, r2modman')}
                  </button>
                  <button
                    className="btn"
                    onClick={async () => {
                      const f = await bridge.dialog('collection-open');
                      if (f && (await run(() => api.importCollectionFile(f)))) go('collections');
                    }}
                  >
                    <Upload size={15} /> {t('Импорт коллекции или сборки')}
                  </button>
                  <button className="btn" disabled={mods.length === 0} onClick={() => useUI.getState().openPlan(t('Безопасное обновление модов'), () => api.planUpdates(profile.id))}>
                    <RefreshCw size={15} /> {t('Обновить безопасно')}
                  </button>
                  <button className="btn" onClick={() => useUI.setState({ journalOpen: true })}>
                    <ClipboardList size={15} /> {t('Журнал Lattice')}
                  </button>
                  <button
                    className="btn"
                    title={t('Версии, список проблем, журнал игры и журнал Lattice одним текстом — без ключей и имени пользователя')}
                    onClick={async () => {
                      const text = await run(() => api.problemReport());
                      if (text) {
                        await navigator.clipboard.writeText(text);
                        useUI.getState().toast('ok', t('Отчёт о проблеме скопирован: вставьте его в сообщение.'));
                      }
                    }}
                  >
                    <FileText size={15} /> {t('Скопировать отчёт о проблеме')}
                  </button>
                </div>
              </section>

              <p className="faint row" style={{ fontSize: 'var(--fs-sm)' }}>
                <Gamepad2 size={13} /> {t('Ctrl+K — быстрый переход к моду, экрану или действию')}
              </p>
            </aside>
          </div>
        </div>
      </div>
      {moving && <ImportSheet onClose={() => setMoving(false)} />}
    </div>
  );
}
