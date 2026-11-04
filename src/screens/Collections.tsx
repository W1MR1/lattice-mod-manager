import { useState } from 'react';
import { Ban, FileDown, Library, Link2, Lock, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import type { Collection } from '../../shared/types';
import { api, bridge } from '../api';
import { ago, LOADER_LABEL, plural } from '../format';
import { useActive, useUI } from '../store';
import { Empty, StatusChip } from '../components/ui';
import { CollectionSheet } from '../sheets/CollectionSheet';
import { t } from '../../shared/i18n';

function bump(v: string) {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(v);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : `${v}.1`;
}

export function Collections() {
  const { state, profile, game, def } = useActive();
  const run = useUI((s) => s.run);
  const openPlan = useUI((s) => s.openPlan);
  const [create, setCreate] = useState(false);
  const [edit, setEdit] = useState<Collection | null>(null);
  if (!state || !profile || !game || !def) return null;

  const mine = state.collections.filter((c) => c.game.defId === def.id);
  const otherCount = state.collections.length - mine.length;
  const byId = new Map(state.collections.map((c) => [c.id, c]));

  const importFile = async () => {
    const f = await bridge.dialog('collection-open');
    if (f) await run(() => api.importCollectionFile(f));
  };

  const toNewProfile = async (c: Collection) => {
    const p = await run(() => api.createProfileForCollection(c.id, game.id));
    if (!p) return;
    await run(() => api.switchProfile(game.id, p.id));
    await openPlan(t('Коллекция «{0}»', c.name), () => api.planCollection(p.id, c.id));
  };

  return (
    <div className="content">
      <div className="screen">
        <div className="toolbar">
          <span className="muted">
            {t('Коллекция — это замок на сборку: точные версии, хэши файлов, правила порядка и связи с другими коллекциями.')}
          </span>
          <span className="grow" />
          <button className="btn" onClick={importFile}>
            <Upload size={15} /> {t('Импорт .json / .mrpack')}
          </button>
          <button className="btn primary" disabled={Object.keys(profile.mods).length === 0} onClick={() => setCreate(true)}>
            <Plus size={15} /> {t('Из текущего профиля')}
          </button>
        </div>
        <div className="screen-scroll">
          {mine.length === 0 ? (
            <Empty
              icon={<Library size={32} color="var(--text-3)" />}
              title={t("Коллекций для этой игры пока нет")}
              text={t("Соберите профиль и закрепите его как коллекцию, импортируйте файл коллекции или сборку Modrinth (.mrpack) — её файлы будут привязаны к проектам по хэшам.")}
            />
          ) : (
            <div className="coll-grid">
              {mine.map((c) => {
                const applied = profile.collections.includes(c.id);
                const optional = c.mods.filter((m) => m.optional).length;
                return (
                  <div key={c.id} className={`card coll ${applied ? 'applied' : ''}`}>
                    <div className="row">
                      <div className="grow" style={{ minWidth: 0 }}>
                        <h3 className="ellipsis">{c.name}</h3>
                        <span className="faint">
                          {c.author || t('без автора')} · {ago(c.createdAt)}
                          {c.importedFrom ? t(' · из {0}', c.importedFrom) : ''}
                        </span>
                      </div>
                      <span className="chip outline mono">{c.version}</span>
                      {applied && <StatusChip tone="accent">{t('В профиле')}</StatusChip>}
                    </div>
                    {c.description && (
                      <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>
                        {c.description}
                      </p>
                    )}
                    <div className="row" style={{ flexWrap: 'wrap' }}>
                      <span className="chip">
                        <Lock size={12} /> {plural(c.mods.length - optional, 'мод', 'мода', 'модов')}
                      </span>
                      {optional > 0 && <span className="chip outline">{t('+{0} по желанию', optional)}</span>}
                      {c.game.gameVersion && <span className="chip outline mono">{c.game.gameVersion}</span>}
                      {c.game.loader && <span className="chip outline">{LOADER_LABEL[c.game.loader] ?? c.game.loader}</span>}
                      {c.rules.length > 0 && <span className="chip outline">{t('Правила порядка: {0}', c.rules.length)}</span>}
                    </div>
                    {(c.requires.length > 0 || c.conflicts.length > 0) && (
                      <div className="coll-links">
                        {c.requires.map((l) => {
                          const target = byId.get(l.collectionId);
                          const ok = profile.collections.includes(l.collectionId);
                          return (
                            <span key={l.collectionId} className="row">
                              <Link2 size={13} color="var(--accent)" />
                              <span className="grow ellipsis">
                                {t('строится поверх «{0}»', target?.name ?? l.name ?? l.collectionId)} <span className="mono faint">{l.range}</span>
                              </span>
                              {!target ? <StatusChip tone="err">{t('Нет в библиотеке')}</StatusChip> : ok ? <StatusChip tone="ok">{t('Применена')}</StatusChip> : <StatusChip tone="info">{t('Поставится')}</StatusChip>}
                            </span>
                          );
                        })}
                        {c.conflicts.map((l) => {
                          const clash = profile.collections.includes(l.collectionId);
                          return (
                            <span key={l.collectionId} className="row">
                              <Ban size={13} color="var(--err)" />
                              <span className="grow ellipsis">
                                {t('несовместима с «{0}»', byId.get(l.collectionId)?.name ?? l.name ?? l.collectionId)}{l.reason ? ` — ${l.reason}` : ''}
                              </span>
                              {clash && <StatusChip tone="err">{t('Конфликт')}</StatusChip>}
                            </span>
                          );
                        })}
                      </div>
                    )}
                    <div className="row" style={{ flexWrap: 'wrap', marginTop: 'auto' }}>
                      {applied ? (
                        <>
                          <button className="btn sm" onClick={() => openPlan(t('Сверка с «{0}»', c.name), () => api.planCollection(profile.id, c.id))}>
                            {t('Сверить с замком')}
                          </button>
                          <button
                            className="btn sm"
                            title={t("Записать текущие версии профиля в коллекцию как новую версию")}
                            onClick={() => run(() => api.relockCollection(c.id, profile.id, bump(c.version)), `«${c.name}» → ${bump(c.version)}`)}
                          >
                            <Lock size={13} /> {t('Перезакрепить')}
                          </button>
                          <button className="btn sm ghost" onClick={() => run(() => api.removeCollectionFromProfile(profile.id, c.id), t('Коллекция убрана из профиля'))}>
                            {t('Убрать из профиля')}
                          </button>
                        </>
                      ) : (
                        <>
                          <button className="btn sm primary" onClick={() => openPlan(t('Коллекция «{0}»', c.name), () => api.planCollection(profile.id, c.id))}>
                            {t('Применить')}
                          </button>
                          <button className="btn sm" onClick={() => toNewProfile(c)}>
                            {t('В новый профиль')}
                          </button>
                        </>
                      )}
                      <span className="grow" />
                      <button className="btn sm ghost icon" title={t("Связи и описание")} aria-label={t("Изменить")} onClick={() => setEdit(c)}>
                        <Pencil size={14} />
                      </button>
                      <button
                        className="btn sm ghost icon"
                        title={t("Экспорт в файл")}
                        aria-label={t("Экспорт")}
                        onClick={async () => {
                          const f = await bridge.dialog('collection-save', `${c.id}.lattice.json`);
                          if (f) await run(() => api.exportCollection(c.id, f));
                        }}
                      >
                        <FileDown size={14} />
                      </button>
                      <button className="btn sm ghost icon danger" title={t("Удалить из библиотеки")} aria-label={t("Удалить")} onClick={() => run(() => api.deleteCollection(c.id), t('Коллекция удалена'))}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {otherCount > 0 && <p className="faint">{t('Ещё {0} для других игр.', plural(otherCount, 'коллекция', 'коллекции', 'коллекций'))}</p>}
        </div>
      </div>
      {create && <CollectionSheet profileId={profile.id} onClose={() => setCreate(false)} />}
      {edit && <CollectionSheet edit={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}
