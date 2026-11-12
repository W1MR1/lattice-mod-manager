import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, Library, Search, Star, X } from 'lucide-react';
import type { ModProject, ModVersion, ProjectKind, SourceId } from '../../shared/types';
import type { ModrinthAccount } from '../../electron/core/sources/modrinth';
import { keyOf } from '../../shared/types';
import { fitsContext } from '../../shared/context';
import { api, bridge } from '../api';
import { ago, count, SOURCE_LABEL } from '../format';
import { useActive, useUI } from '../store';
import { Empty, ModIcon, SevIcon, Spinner, StatusChip, Switch } from '../components/ui';
import { t, tk } from '../../shared/i18n';

const KINDS: [ProjectKind, string][] = [
  ['mod', tk('Моды')],
  ['modpack', tk('Сборки')],
  ['resourcepack', tk('Ресурспаки')],
  ['shader', tk('Шейдеры')],
];

export function Discover() {
  const { profile, def } = useActive();
  const openPlan = useUI((s) => s.openPlan);
  const run = useUI((s) => s.run);
  const go = useUI((s) => s.go);
  const [cfGame, setCfGame] = useState(false);
  const sources = (def?.sources ?? []).filter((s): s is Exclude<SourceId, 'local'> => s !== 'local' && (s !== 'curseforge' || def?.id === 'minecraft' || cfGame));
  const [source, setSource] = useState<Exclude<SourceId, 'local'>>(sources[0] ?? 'modrinth');
  const [text, setText] = useState(() => {
    const handed = useUI.getState().discoverText;
    if (handed) useUI.setState({ discoverText: null });
    return handed ?? '';
  });
  const [kind, setKind] = useState<ProjectKind>('mod');
  const [compatible, setCompatible] = useState(true);
  const [hits, setHits] = useState<ModProject[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ModProject | null>(null);
  const settings = useUI((s) => s.state?.settings);
  const [cfReady, setCfReady] = useState<boolean | null>(null);
  // a Modrinth account list instead of the catalogue: '' | 'follows' | collection id
  const [list, setList] = useState('');
  const [account, setAccount] = useState<ModrinthAccount | null>(null);
  const seq = useRef(0);
  const hasAccount = !!(settings?.modrinthUser || settings?.modrinthToken);
  // what each source can show: Nexus and Thunderstore have mods and modpacks (Nexus Collections, Thunderstore modpacks)
  const kinds = source === 'curseforge' ? KINDS.filter(([k]) => k !== 'modpack') : source === 'nexus' || source === 'thunderstore' ? KINDS.filter(([k]) => k === 'mod' || k === 'modpack') : KINDS;
  const typed = source !== 'github' && source !== 'gamebanana';

  useEffect(() => {
    void api
      .curseforgeAvailable()
      .then(setCfReady)
      .catch(() => setCfReady(false));
    if (def && def.id !== 'minecraft')
      void api
        .curseforgeAvailable(def.id)
        .then(setCfGame)
        .catch(() => setCfGame(false));
  }, [settings?.curseforgeKey, def?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setAccount(null);
    setList('');
    if (source !== 'modrinth' || !hasAccount) return;
    void api
      .modrinthAccount()
      .then(setAccount)
      .catch(() => setAccount(null));
  }, [source, settings?.modrinthUser, settings?.modrinthToken]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!sources.includes(source) && sources[0]) setSource(sources[0]);
  }, [def?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!kinds.some(([k]) => k === kind)) setKind('mod');
  }, [source]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = async (offset: number) => {
    if (!profile) return;
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      if (source === 'curseforge' && cfReady === false) {
        setHits([]);
        setTotal(0);
        return;
      }
      if (source === 'modrinth' && list) {
        // one of the account's lists, filtered here by the search text
        const all = await api.modrinthList(list === 'follows' ? { follows: true } : { collection: list });
        if (my !== seq.current) return;
        const q = text.trim().toLowerCase();
        const found = q ? all.filter((p) => p.title.toLowerCase().includes(q)) : all;
        setHits(found);
        setTotal(found.length);
        return;
      }
      const r = await api.search({ source, text, ctx: profile.context, kind: typed ? kind : undefined, offset, limit: 30, compatibleOnly: compatible });
      if (my !== seq.current) return;
      setHits((h) => (offset ? [...h, ...r.hits] : r.hits));
      setTotal(r.total);
    } catch (e) {
      if (my === seq.current) setError((e as Error).message);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => void load(0), text ? 350 : 0);
    return () => clearTimeout(t);
  }, [source, text, kind, compatible, list, cfReady, profile?.id, profile?.context.gameVersion, profile?.context.loader]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!profile || !def) return null;
  const installed = (p: ModProject) => !!profile.mods[keyOf(p.ref)];
  const installAll = () => {
    const todo = hits.filter((p) => !installed(p) && p.kind !== 'modpack');
    if (!todo.length) return;
    const name = list === 'follows' ? t('Подписки') : (account?.collections.find((c) => c.id === list)?.name ?? '');
    void openPlan(t('Установка из «{0}»', name), () => api.planInstall(profile.id, todo.map((p) => ({ ref: p.ref, title: p.title }))));
  };

  const install = (p: ModProject, versionId?: string) => openPlan(t('Установка «{0}»', p.title), () => api.planInstall(profile.id, [{ ref: p.ref, versionId, title: p.title }]));
  const importPack = async (p: ModProject) => {
    const c = await run(() => api.importModpack(p.ref));
    if (c) go('collections');
  };

  return (
    <div className="content">
      <div className="screen">
        <div className="toolbar">
          {sources.length > 1 && (
            <div className="seg" role="group" aria-label={t("Источник")}>
              {sources.map((s) => (
                <button key={s} aria-pressed={source === s} onClick={() => setSource(s)}>
                  {SOURCE_LABEL[s]}
                </button>
              ))}
            </div>
          )}
          <div className="search grow" style={{ maxWidth: 420 }}>
            <Search size={15} />
            <input
              className="input"
              placeholder={source === 'github' ? t('Поиск или владелец/репозиторий') : t('Поиск на {0}', SOURCE_LABEL[source])}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label={t("Поиск модов")}
            />
          </div>
          {source === 'modrinth' && account && (
            <select className="select" value={list} onChange={(e) => setList(e.target.value)} aria-label={t('Что показывать')} title={t('Аккаунт Modrinth: {0}', account.username)}>
              <option value="">{t('Весь каталог')}</option>
              {account.follows && <option value="follows">{t('Мои подписки')}</option>}
              {account.collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {t('Коллекция «{0}» ({1})', c.name, c.count)}
                </option>
              ))}
            </select>
          )}
          {typed && !list && (
            <div className="seg" role="group" aria-label={t("Тип")}>
              {kinds.map(([k, l]) => (
                <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
                  {t(l)}
                </button>
              ))}
            </div>
          )}
          <span className="grow" />
          {list && hits.some((p) => !installed(p)) && (
            <button className="btn primary" onClick={installAll}>
              <Download size={15} /> {t('Установить все ({0})', hits.filter((p) => !installed(p) && p.kind !== 'modpack').length)}
            </button>
          )}
          {(source === 'modrinth' || source === 'curseforge') && !list && (
            <label className="row muted" title={t("Показывать только то, что подходит к версии игры и загрузчику профиля")}>
              <Switch on={compatible} onChange={setCompatible} label={t("Только совместимые")} />
              {t('Только совместимые')}
            </label>
          )}
        </div>

        <div className="screen-scroll">
          {source === 'curseforge' && cfReady === false ? (
            <Empty
              title={t('CurseForge пока не подключён')}
              text={t('CurseForge выдаёт доступ к своему API только по ключу. Если у вас есть ключ (console.curseforge.com), укажите его в настройках — поиск и установка заработают здесь же.')}
              action={
                <button className="btn" onClick={() => go('settings')}>
                  {t('Открыть настройки')}
                </button>
              }
            />
          ) : error ? (
            <Empty title={t("Источник не ответил")} text={error} action={<button className="btn" onClick={() => load(0)}>{t('Повторить')}</button>} />
          ) : hits.length === 0 && loading ? (
            <Empty
              icon={<Spinner size={22} />}
              title={source === 'thunderstore' ? t('Загружаем индекс сообщества') : t('Ищем')}
              text={source === 'thunderstore' ? t('Полный список пакетов скачивается один раз и потом берётся из кэша.') : undefined}
            />
          ) : hits.length === 0 ? (
            <Empty title={t("Ничего не нашлось")} text={compatible ? t('Попробуйте выключить «Только совместимые» или изменить запрос.') : t('Попробуйте другой запрос.')} />
          ) : (
            <>
              {source === 'github' && (
                <div className="issue-row" style={{ marginBottom: 12, border: '1px solid var(--line)', borderRadius: 'var(--r-md)' }}>
                  <SevIcon s="warning" />
                  <span className="msg">
                    {t('GitHub — не каталог модов: репозиторий может выложить кто угодно, а звёзды накручивают. Под видом модов и читов там распространяют программы, которые крадут пароли. Ставьте то, что знаете: проекты, на которые ссылается сам автор мода или его страница на Modrinth, Nexus, Thunderstore.')}
                  </span>
                </div>
              )}
              <div className="row" style={{ marginBottom: 12 }}>
                <span className="faint">
                  {t('{0} результатов · {1}', count(total), SOURCE_LABEL[source])}
                  {source === 'modrinth' && compatible && profile.context.gameVersion ? ` · ${profile.context.gameVersion} ${profile.context.loader ?? ''}` : ''}
                </span>
              </div>
              <div className="results">
                {hits.map((p) => (
                  <div key={keyOf(p.ref)} className="result" aria-selected={selected?.ref.projectId === p.ref.projectId} onClick={() => setSelected(p)}>
                    <ModIcon url={p.iconUrl} title={p.title} size="lg" />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="row">
                        <b className="ellipsis grow">{p.title}</b>
                        {installed(p) ? (
                          <StatusChip tone="ok">{t('В профиле')}</StatusChip>
                        ) : p.kind === 'modpack' && p.ref.source !== 'thunderstore' ? (
                          <button
                            className="btn sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              void importPack(p);
                            }}
                          >
                            <Library size={13} /> {t('В коллекции')}
                          </button>
                        ) : (
                          <button
                            className="btn sm primary"
                            onClick={(e) => {
                              e.stopPropagation();
                              void install(p);
                            }}
                          >
                            <Download size={13} /> {t('Установить')}
                          </button>
                        )}
                      </div>
                      <p>{p.summary}</p>
                      <div className="result-meta">
                        <span>{p.author}</span>
                        {p.downloads > 0 && (
                          <span className="row" style={{ gap: 3 }}>
                            {source === 'github' ? <Star size={12} /> : <Download size={12} />}
                            {count(p.downloads)}
                          </span>
                        )}
                        <span>{ago(p.updated)}</span>
                        {p.categories.slice(0, 2).map((c) => (
                          <span key={c} className="chip outline" style={{ height: 18, fontSize: 11 }}>
                            {c}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {!list && hits.length < total && (
                <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
                  <button className="btn" disabled={loading} onClick={() => load(hits.length)}>
                    {loading && <Spinner />} {t('Показать ещё')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {selected && <ProjectPanel p={selected} onInstall={install} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ProjectPanel({ p, onInstall, onClose }: { p: ModProject; onInstall: (p: ModProject, versionId?: string) => void; onClose: () => void }) {
  const { profile } = useActive();
  const [versions, setVersions] = useState<ModVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setVersions(null);
    setError(null);
    if (!profile || p.kind === 'modpack') return;
    api
      .versions(p.ref, profile.id)
      .then((v) => setVersions(v.slice(0, 40)))
      .catch((e) => setError((e as Error).message));
  }, [p.ref.projectId, profile?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!profile) return null;
  const inst = profile.mods[keyOf(p.ref)];
  return (
    <aside className="inspector" aria-label={p.title}>
      <div className="inspector-head">
        <ModIcon url={p.iconUrl} title={p.title} size="lg" />
        <div className="grow" style={{ minWidth: 0 }}>
          <h2 className="ellipsis">{p.title}</h2>
          <div className="muted">{p.author}</div>
        </div>
        <button className="btn ghost sm icon" onClick={onClose} aria-label={t("Закрыть")}>
          <X size={16} />
        </button>
      </div>
      <div className="inspector-body">
        <p style={{ margin: 0, userSelect: 'text' }} className="muted">
          {p.summary}
        </p>
        {p.url && (
          <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => bridge.openExternal(p.url)}>
            <ExternalLink size={13} /> {t('Страница проекта')}
          </button>
        )}
        {p.kind !== 'modpack' && (
          <div className="col">
            <span className="label">{t('Версии')}</span>
            {error && <span className="faint">{error}</span>}
            {!versions && !error && <Spinner />}
            {versions?.length === 0 && <span className="faint">{t('Нет версий для этого профиля.')}</span>}
            <div className="link-list">
              {versions?.map((v) => {
                const ok = fitsContext(v, profile.context);
                const current = inst?.versionId === v.versionId;
                return (
                  <div className="link-item" key={v.versionId}>
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="mono">{v.version}</span>
                      <span className="faint ellipsis" style={{ display: 'block', fontSize: 11 }}>
                        {[v.loaders.join(', '), v.gameVersions.slice(-3).join(', '), ago(v.published)].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    {current ? (
                      <StatusChip tone="accent">{t('Установлена')}</StatusChip>
                    ) : ok ? (
                      <button className="btn sm" onClick={() => onInstall(p, v.versionId)}>
                        {t('Выбрать')}
                      </button>
                    ) : (
                      <StatusChip tone="warn" title={t("Не подходит к версии игры или загрузчику профиля")}>
                        {t('Не подходит')}
                      </StatusChip>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
