import { Download, Pause, Play, X } from 'lucide-react';
import { api, bridge } from '../api';
import { bytes, eta, speed } from '../format';
import { useUI } from '../store';
import { Empty, SegmentBar, StatusChip, Stepper, type Tone } from '../components/ui';
import type { DownloadState } from '../../shared/types';

const STATE: Record<DownloadState, [Tone, string]> = {
  queued: ['muted', 'В очереди'],
  probing: ['info', 'Подключение'],
  downloading: ['info', 'Загрузка'],
  paused: ['warn', 'Пауза'],
  verifying: ['info', 'Проверка хэша'],
  done: ['ok', 'Готово'],
  error: ['err', 'Ошибка'],
  cancelled: ['muted', 'Отменено'],
};

export function Downloads() {
  const downloads = useUI((s) => s.downloads);
  const settings = useUI((s) => s.state?.settings);
  const run = useUI((s) => s.run);
  const total = downloads.reduce((a, d) => a + d.speed, 0);
  const conns = downloads.reduce((a, d) => a + d.connections, 0);
  const done = downloads.filter((d) => d.state === 'done');
  const verified = done.filter((d) => d.verified && d.verified !== 'none').length;
  const act = (action: 'pause' | 'resume' | 'cancel' | 'clear', id?: string) => bridge.downloads(action, id).then((d) => useUI.setState({ downloads: d }));

  return (
    <div className="content">
      <div className="screen">
        <div className="toolbar">
          <span className="muted">Своих ограничений скорости нет. Файл делится на диапазоны и качается параллельными потоками; освободившийся поток забирает половину самого большого остатка.</span>
          <span className="grow" />
          <button className="btn ghost" disabled={!downloads.some((d) => ['done', 'error', 'cancelled'].includes(d.state))} onClick={() => act('clear')}>
            Очистить завершённые
          </button>
        </div>
        <div className="screen-scroll">
          <div className="dl-hero">
            <div className="card stat">
              <div className="label">Скорость сейчас</div>
              <div className="value">
                {bytes(total).split(' ')[0]}
                <small>{bytes(total).split(' ')[1]}/с</small>
              </div>
            </div>
            <div className="card stat">
              <div className="label">Активных потоков</div>
              <div className="value">{conns}</div>
            </div>
            <div className="card stat">
              <div className="label">Параллельных загрузок</div>
              <div className="row" style={{ marginTop: 6 }}>
                {settings && <Stepper value={settings.maxParallelDownloads} min={1} max={32} onChange={(v) => run(() => api.updateSettings({ maxParallelDownloads: v }))} />}
              </div>
            </div>
            <div className="card stat">
              <div className="label">Потоков на файл</div>
              <div className="row" style={{ marginTop: 6 }}>
                {settings && <Stepper value={settings.maxConnectionsPerFile} min={1} max={32} onChange={(v) => run(() => api.updateSettings({ maxConnectionsPerFile: v }))} />}
              </div>
            </div>
          </div>
          {downloads.length === 0 ? (
            <Empty icon={<Download size={32} color="var(--text-3)" />} title="Загрузок пока не было" text="Когда вы устанавливаете мод или коллекцию, файлы появятся здесь — с потоками, скоростью и проверкой хэша." />
          ) : (
            <div className="card">
              {downloads.map((d) => {
                const [tone, word] = STATE[d.state];
                return (
                  <div className="dl" key={d.id}>
                    <div className="row">
                      <div className="grow" style={{ minWidth: 0 }}>
                        <b className="ellipsis" style={{ display: 'block' }}>
                          {d.title}
                        </b>
                        <span className="faint mono ellipsis" style={{ display: 'block' }}>
                          {d.filename} · {d.host}
                        </span>
                      </div>
                      <StatusChip tone={tone} title={d.error}>
                        {word}
                      </StatusChip>
                      {(d.state === 'downloading' || d.state === 'queued' || d.state === 'probing') && (
                        <button className="btn ghost sm icon" aria-label="Пауза" onClick={() => act('pause', d.id)}>
                          <Pause size={14} />
                        </button>
                      )}
                      {(d.state === 'paused' || d.state === 'error') && (
                        <button className="btn ghost sm icon" aria-label="Продолжить" onClick={() => act('resume', d.id)}>
                          <Play size={14} />
                        </button>
                      )}
                      {d.state !== 'done' && d.state !== 'cancelled' && (
                        <button className="btn ghost sm icon" aria-label="Отменить" onClick={() => act('cancel', d.id)}>
                          <X size={14} />
                        </button>
                      )}
                    </div>
                    <SegmentBar d={d} />
                    <div className="row faint mono" style={{ gap: 16 }}>
                      <span>
                        {bytes(d.received)} / {d.size ? bytes(d.size) : '?'}
                      </span>
                      {d.state === 'downloading' && (
                        <>
                          <span>{speed(d.speed)}</span>
                          <span>{d.connections} пот.</span>
                          <span>осталось {eta(d.size - d.received, d.speed)}</span>
                        </>
                      )}
                      <span>{d.rangeSupported ? `${d.segments.length} сегм.` : 'один поток (сервер без Range)'}</span>
                      {d.verified && d.verified !== 'none' && <span style={{ color: 'var(--ok)' }}>✓ {d.verified}</span>}
                      {d.error && <span style={{ color: 'var(--err)' }}>{d.error}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {done.length > 0 && (
            <p className="faint" style={{ marginTop: 12 }}>
              Проверено по хэшу: {verified} из {done.length}. Файлы без хэша в источнике (Thunderstore, часть GitHub) проверяются только по размеру.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
