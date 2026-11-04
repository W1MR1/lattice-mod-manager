import { useState } from 'react';
import { Camera, History, Trash2, Undo2 } from 'lucide-react';
import { api } from '../api';
import { ago, plural } from '../format';
import { useActive, useUI } from '../store';
import { Empty, Modal } from '../components/ui';
import type { Snapshot } from '../../shared/types';

function diff(s: Snapshot, current: Record<string, { versionId: string; enabled: boolean }>) {
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const k of Object.keys(current)) if (!s.mods[k]) added++;
  for (const [k, m] of Object.entries(s.mods)) {
    if (!current[k]) removed++;
    else if (current[k].versionId !== m.versionId || current[k].enabled !== m.enabled) changed++;
  }
  return { added, removed, changed };
}

export function Snapshots() {
  const { state, profile } = useActive();
  const run = useUI((s) => s.run);
  const [confirm, setConfirm] = useState<Snapshot | null>(null);
  if (!state || !profile) return null;
  const list = state.snapshots.filter((s) => s.profileId === profile.id);

  return (
    <div className="content">
      <div className="screen">
        <div className="toolbar">
          <span className="muted">Снимок делается сам перед каждым изменением. Откат возвращает моды, версии, правила и коллекции и заново разворачивает игру.</span>
          <span className="grow" />
          <button className="btn" onClick={() => run(() => api.snapshot(profile.id, 'Снимок вручную'), 'Снимок сохранён')}>
            <Camera size={15} /> Сделать снимок
          </button>
        </div>
        <div className="screen-scroll">
          {list.length === 0 ? (
            <Empty icon={<History size={32} color="var(--text-3)" />} title="Снимков пока нет" text="Они появятся при первой установке, обновлении или удалении." />
          ) : (
            <div className="timeline">
              {list.map((s) => {
                const d = diff(s, profile.mods);
                const same = d.added + d.removed + d.changed === 0;
                return (
                  <div key={s.id} className="card snap">
                    <div className="grow" style={{ minWidth: 0 }}>
                      <b className="ellipsis" style={{ display: 'block' }}>
                        {s.label}
                      </b>
                      <span className="faint">
                        {ago(s.createdAt)} · {plural(Object.keys(s.mods).length, 'мод', 'мода', 'модов')}
                      </span>
                    </div>
                    <span className="muted mono" style={{ fontSize: 'var(--fs-sm)' }}>
                      {same ? 'совпадает с текущим' : `сейчас: +${d.added} −${d.removed} ~${d.changed}`}
                    </span>
                    <button className="btn sm" disabled={same} onClick={() => setConfirm(s)}>
                      <Undo2 size={13} /> Откатить
                    </button>
                    <button className="btn sm ghost icon" aria-label="Удалить снимок" onClick={() => run(() => api.deleteSnapshot(s.id))}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {confirm && (
        <Modal
          title="Откатить профиль?"
          sub={`К состоянию «${confirm.label}» (${ago(confirm.createdAt)}). Текущее состояние сохранится отдельным снимком.`}
          size="sm"
          onClose={() => setConfirm(null)}
          foot={
            <>
              <span className="grow" />
              <button className="btn ghost" onClick={() => setConfirm(null)}>
                Отмена
              </button>
              <button
                className="btn primary"
                onClick={async () => {
                  await run(() => api.rollback(confirm.id));
                  setConfirm(null);
                }}
              >
                Откатить
              </button>
            </>
          }
        >
          <span />
        </Modal>
      )}
    </div>
  );
}
