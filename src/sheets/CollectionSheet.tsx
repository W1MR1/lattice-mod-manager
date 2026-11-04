import { useState } from 'react';
import { Ban, Link2, Trash2 } from 'lucide-react';
import type { Collection, CollectionLink } from '../../shared/types';
import { api } from '../api';
import { plural } from '../format';
import { useActive, useUI } from '../store';
import { Modal } from '../components/ui';
import { t } from '../../shared/i18n';

/** Create a collection from a profile, or edit an existing one's metadata and links. */
export function CollectionSheet({ profileId, edit, onClose }: { profileId?: string; edit?: Collection; onClose: () => void }) {
  const { state, profile } = useActive();
  const run = useUI((s) => s.run);
  const [name, setName] = useState(edit?.name ?? `${profile?.name ?? t('Сборка')}`);
  const [version, setVersion] = useState(edit?.version ?? '1.0.0');
  const [author, setAuthor] = useState(edit?.author ?? '');
  const [description, setDescription] = useState(edit?.description ?? '');
  const [requires, setRequires] = useState<CollectionLink[]>(edit?.requires ?? []);
  const [conflicts, setConflicts] = useState<CollectionLink[]>(edit?.conflicts ?? []);
  const [pick, setPick] = useState('');
  const [pickKind, setPickKind] = useState<'requires' | 'conflicts'>('requires');

  const gameDef = edit?.game.defId ?? profile?.context.gameDefId;
  const candidates = (state?.collections ?? []).filter((c) => c.id !== edit?.id && c.game.defId === gameDef && !requires.some((r) => r.collectionId === c.id) && !conflicts.some((r) => r.collectionId === c.id));
  const nameOf = (id: string) => state?.collections.find((c) => c.id === id)?.name ?? id;
  const applied = profile ? new Set(profile.collections) : new Set<string>();
  const modCount = profile ? Object.values(profile.mods).filter((m) => m.enabled).length : 0;

  const save = async () => {
    const meta = { name: name.trim() || t('Коллекция'), version: version.trim() || '1.0.0', author: author.trim(), description: description.trim(), requires, conflicts };
    const ok = edit ? await run(() => api.updateCollection(edit.id, meta), t('Коллекция обновлена')) : await run(() => api.createCollection(profileId!, meta), t('Коллекция «{0}» создана', meta.name));
    if (ok !== undefined) onClose();
  };

  return (
    <Modal
      title={edit ? t('Коллекция «{0}»', edit.name) : t('Новая коллекция из профиля')}
      sub={
        edit
          ? t('Версия, описание и связи с другими коллекциями.')
          : t('Закрепит {0} с точными версиями, хэшами и правилами порядка.', plural(modCount, 'включённый мод', 'включённых мода', 'включённых модов'))
      }
      onClose={onClose}
      foot={
        <>
          <span className="grow" />
          <button className="btn ghost" onClick={onClose}>
            {t('Отмена')}
          </button>
          <button className="btn primary" onClick={save}>
            {edit ? t('Сохранить') : t('Создать коллекцию')}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label htmlFor="cname">{t('Название')}</label>
        <input id="cname" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <label htmlFor="cver">{t('Версия')}</label>
        <input id="cver" className="input mono" value={version} onChange={(e) => setVersion(e.target.value)} style={{ width: 140 }} />
        <label htmlFor="cauth">{t('Автор')}</label>
        <input id="cauth" className="input" value={author} onChange={(e) => setAuthor(e.target.value)} />
        <label htmlFor="cdesc">{t('Описание')}</label>
        <textarea id="cdesc" className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>

      <div className="col">
        <span className="label">{t('Связи с другими коллекциями')}</span>
        <span className="faint" style={{ fontSize: 'var(--fs-sm)' }}>
          {t('«Строится поверх» — базовая коллекция ставится первой и проверяется по диапазону версии. «Несовместима» — их нельзя применить вместе.')}
          {!edit && applied.size > 0 && ` ${t('Коллекции, уже применённые к профилю, добавятся как базовые автоматически.')}`}
        </span>
        <div className="link-list">
          {requires.map((l) => (
            <div className="link-item" key={`r${l.collectionId}`}>
              <Link2 size={14} color="var(--accent)" />
              <span className="grow ellipsis">{t('строится поверх «{0}»', l.name ?? nameOf(l.collectionId))}</span>
              <input
                className="input mono"
                style={{ width: 110, height: 28 }}
                value={l.range ?? ''}
                placeholder="^1.0.0"
                aria-label={t("Диапазон версии")}
                onChange={(e) => setRequires(requires.map((x) => (x === l ? { ...x, range: e.target.value || undefined } : x)))}
              />
              <button className="btn ghost sm icon" aria-label={t("Убрать")} onClick={() => setRequires(requires.filter((x) => x !== l))}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {conflicts.map((l) => (
            <div className="link-item" key={`c${l.collectionId}`}>
              <Ban size={14} color="var(--err)" />
              <span className="grow ellipsis">{t('несовместима с «{0}»', l.name ?? nameOf(l.collectionId))}</span>
              <input
                className="input"
                style={{ width: 180, height: 28 }}
                value={l.reason ?? ''}
                placeholder={t("почему (необязательно)")}
                aria-label={t("Причина")}
                onChange={(e) => setConflicts(conflicts.map((x) => (x === l ? { ...x, reason: e.target.value || undefined } : x)))}
              />
              <button className="btn ghost sm icon" aria-label={t("Убрать")} onClick={() => setConflicts(conflicts.filter((x) => x !== l))}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="row">
          <select className="select" style={{ width: 170 }} value={pickKind} onChange={(e) => setPickKind(e.target.value as 'requires' | 'conflicts')} aria-label={t("Тип связи")}>
            <option value="requires">{t('строится поверх')}</option>
            <option value="conflicts">{t('несовместима с')}</option>
          </select>
          <select className="select grow" value={pick} onChange={(e) => setPick(e.target.value)} aria-label={t("Коллекция")}>
            <option value="">{candidates.length ? t('выберите коллекцию…') : t('других коллекций для этой игры нет')}</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} {c.version}
              </option>
            ))}
          </select>
          <button
            className="btn"
            disabled={!pick}
            onClick={() => {
              const c = state!.collections.find((x) => x.id === pick)!;
              if (pickKind === 'requires') setRequires([...requires, { collectionId: c.id, name: c.name, range: `^${c.version}` }]);
              else setConflicts([...conflicts, { collectionId: c.id, name: c.name }]);
              setPick('');
            }}
          >
            {t('Добавить связь')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
