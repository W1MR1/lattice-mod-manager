import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, Library, Search, Star, X } from 'lucide-react';
import type { ModProject, ModVersion, ProjectKind, SourceId } from '../../shared/types';
import { keyOf } from '../../shared/types';
import { fitsContext } from '../../shared/context';
import { api, bridge } from '../api';
import { ago, count, SOURCE_LABEL } from '../format';
import { useActive, useUI } from '../store';
import { Empty, ModIcon, Spinner, StatusChip, Switch } from '../components/ui';
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
  const sources = (def?.sources ?? []).filter((s): s is Exclude<SourceId, 'local'> => s !== 'local');
  const [source, setSource] = useState<Exclude<SourceId, 'local'>>(sources[0] ?? 'modrinth');
  const [text, setText] = useState('');
  const [kind, setKind] = useState<ProjectKind>('mod');
  const [compatible, setCompatible] = useState(true);
  const [hits, setHits] = useState<ModProject[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ModProject | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!sources.includes(source) && sources[0]) setSource(sources[0]);
  }, [def?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = async (offset: number) => {
    if (!profile) return;
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const r = await api.search({ source, text, ctx: profile.context, kind: source === 'modrinth' ? kind : undefined, offset, limit: 30, compatibleOnly: compatible });
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
  }, [source, text, kind, compatible, profile?.id, profile?.context.gameVersion, profile?.context.loader]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!profile || !def) return null;
  const installed = (p: ModProject) => !!profile.mods[keyOf(p.ref)];

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
          {source === 'modrinth' && (
            <div className="seg" role="group" aria-label={t("Тип")}>
              {KINDS.map(([k, l]) => (
                <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
                  {t(l)}
                </button>
              ))}
            </div>
          )}
          <span className="grow" />
          {source === 'modrinth' && (
            <label className="row muted" title={t("Показывать только то, что подходит к версии игры и загрузчику профиля")}>
              <Switch on={compatible} onChange={setCompatible} label={t("Только совместимые")} />
              {t('Только совместимые')}
            </label>
          )}
        </div>

        <div className="screen-scroll">
          {error ? (
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
                        ) : p.kind === 'modpack' ? (
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
                        <span className="row" style={{ gap: 3 }}>
                          {source === 'github' ? <Star size={12} /> : <Download size={12} />}
                          {count(p.downloads)}
                        </span>
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
              {hits.length < total && (
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
