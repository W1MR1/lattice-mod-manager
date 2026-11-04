import { useEffect, useMemo, useState } from 'react';
import { CornerLeftUp, Trash2, TriangleAlert } from 'lucide-react';
import type { Leftover } from '../../electron/core/cleanup';
import { api } from '../api';
import { bytes, plural } from '../format';
import { useUI } from '../store';
import { Modal, Spinner, Switch } from '../components/ui';

type Preview = Awaited<ReturnType<typeof api.previewRemoval>>;

/**
 * Removing one, several or all mods: the user decides whether their unused
 * dependencies and the mods that need them go too, and whether to remove every
 * trace (staged copies, downloads, settings files) afterwards.
 */
export function RemoveSheet({ profileId, keys, all, onClose }: { profileId: string; keys: string[]; all?: boolean; onClose: () => void }) {
  const toast = useUI((s) => s.toast);
  const [withDeps, setWithDeps] = useState(true);
  const [withDependents, setWithDependents] = useState(!!all);
  const [thorough, setThorough] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [leftovers, setLeftovers] = useState<Leftover[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  useEffect(() => {
    api
      .previewRemoval(profileId, keys, { withDeps, withDependents })
      .then(setPreview)
      .catch(() => setPreview(null));
  }, [profileId, keys, withDeps, withDependents]);

  const blocked = !!preview && preview.dependents.length > 0 && !withDependents;
  const title = all ? 'Удалить все моды профиля?' : keys.length === 1 ? `Удалить «${preview?.remove[0]?.title ?? '…'}»?` : `Удалить ${plural(keys.length, 'мод', 'мода', 'модов')}?`;

  const remove = async () => {
    setBusy(true);
    try {
      const r = await api.removeMods(profileId, keys, { withDeps, withDependents, thorough });
      if (r.blockedBy.length) return;
      if (thorough && r.leftovers.length) {
        setLeftovers(r.leftovers);
        setChecked(new Set(r.leftovers.filter((l) => l.checked).map((l) => l.path)));
        return;
      }
      toast('ok', `Удалено: ${plural(r.removed.length, 'мод', 'мода', 'модов')}${thorough ? '. Следов не найдено' : ''}`);
      onClose();
    } catch (e) {
      toast('err', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const total = useMemo(() => (leftovers ?? []).filter((l) => checked.has(l.path)).reduce((a, l) => a + l.size, 0), [leftovers, checked]);

  if (leftovers) {
    return (
      <Modal
        title="Следы удалённых модов"
        sub="Моды уже убраны из профиля и из папки игры. Ниже — что от них осталось. Удалится только отмеченное."
        onClose={onClose}
        foot={
          <>
            <span className="grow faint">После удаления копий откатиться к снимкам с этими модами можно будет только после повторной загрузки.</span>
            <button className="btn ghost" onClick={onClose}>
              Оставить
            </button>
            <button
              className="btn danger"
              disabled={busy || checked.size === 0}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api.deleteLeftovers([...checked]);
                  toast('ok', `Удалено следов: ${r.deleted}, освобождено ${bytes(r.freed)}`);
                  onClose();
                } catch (e) {
                  toast('err', (e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Spinner /> : <Trash2 size={14} />} Удалить отмеченное ({bytes(total)})
            </button>
          </>
        }
      >
        <div className="plan-list">
          {leftovers.map((l) => (
            <label className="plan-item" key={l.path} style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={checked.has(l.path)}
                onChange={(e) => {
                  const next = new Set(checked);
                  if (e.target.checked) next.add(l.path);
                  else next.delete(l.path);
                  setChecked(next);
                }}
              />
              <div className="mod-name grow">
                <b className="ellipsis">
                  {l.ownerTitle} · {l.note}
                </b>
                <small className="ellipsis mono" title={l.path}>
                  {l.path}
                </small>
              </div>
              <span className="mono muted">{bytes(l.size)}</span>
            </label>
          ))}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={title}
      sub="Перед удалением Lattice сделает снимок профиля — всё можно будет вернуть."
      onClose={onClose}
      foot={
        <>
          <span className="grow" />
          <button className="btn ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="btn danger" disabled={busy || !preview || blocked} onClick={remove}>
            {busy ? <Spinner /> : <Trash2 size={14} />} Удалить
          </button>
        </>
      }
    >
      {!preview ? (
        <Spinner />
      ) : (
        <>
          {!all && preview.remove.length > 0 && (
            <p className="muted" style={{ margin: 0 }}>
              {preview.remove.map((m) => `«${m.title}»`).join(', ')}
            </p>
          )}

          <div className="col">
            <span className="label">Зависимости</span>
            <div className="seg" role="radiogroup" aria-label="Зависимости" style={{ alignSelf: 'flex-start' }}>
              <button role="radio" aria-pressed={withDeps} aria-checked={withDeps} onClick={() => setWithDeps(true)}>
                Удалить и их{preview.deps.length ? ` (${preview.deps.length})` : ''}
              </button>
              <button role="radio" aria-pressed={!withDeps} aria-checked={!withDeps} onClick={() => setWithDeps(false)}>
                Только {keys.length === 1 ? 'этот мод' : 'выбранные'}
              </button>
            </div>
            <span className="faint" style={{ fontSize: 'var(--fs-sm)' }}>
              {preview.deps.length === 0
                ? 'Лишних зависимостей не останется.'
                : withDeps
                  ? `Уйдут и зависимости, которые больше никому не нужны: ${preview.deps.map((d) => `«${d.title}»`).join(', ')}.`
                  : `Зависимости останутся и станут обычными модами профиля: ${preview.deps.map((d) => `«${d.title}»`).join(', ')}.`}
            </span>
          </div>

          {preview.dependents.length > 0 && (
            <div className="risk-note" role="note">
              <TriangleAlert size={18} aria-hidden />
              <div className="grow">
                <b>Без {keys.length === 1 ? 'него' : 'них'} не запустятся:</b>
                <div className="link-list" style={{ margin: '4px 0 8px' }}>
                  {preview.dependents.map((d) => (
                    <span className="row" key={d.key}>
                      <CornerLeftUp size={13} /> {d.title}
                    </span>
                  ))}
                </div>
                <label className="row">
                  <Switch on={withDependents} onChange={setWithDependents} label="Удалить и зависящие моды" />
                  Удалить и эти моды тоже
                </label>
              </div>
            </div>
          )}

          <label className="row">
            <Switch on={thorough} onChange={setThorough} label="Удалить без следов" />
            <span>
              Удалить без следов
              <small className="faint" style={{ display: 'block', fontSize: 'var(--fs-sm)' }}>
                После удаления Lattice найдёт подготовленные копии, скачанные архивы и файлы настроек этих модов в папке игры и покажет их списком.
              </small>
            </span>
          </label>
        </>
      )}
    </Modal>
  );
}
