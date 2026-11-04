import { useState } from 'react';
import { Download, Pause, Play, X } from 'lucide-react';
import { api, bridge } from '../api';
import { bytes, eta, speed } from '../format';
import { useActive, useUI } from '../store';
import { Empty, SegmentBar, StatusChip, Stepper, type Tone } from '../components/ui';
import type { DownloadState } from '../../shared/types';
import { t, tk } from '../../shared/i18n';

const STATE: Record<DownloadState, [Tone, string]> = {
  queued: ['muted', tk('В очереди')],
  probing: ['info', tk('Подключение')],
  downloading: ['info', tk('Загрузка')],
  paused: ['warn', tk('Пауза')],
  verifying: ['info', tk('Проверка хэша')],
  done: ['ok', tk('Готово')],
  error: ['err', tk('Ошибка')],
  cancelled: ['muted', tk('Отменено')],
};

export function Downloads() {
  const all = useUI((s) => s.downloads);
  const { game } = useActive();
  const [scope, setScope] = useState<'game' | 'all'>('game');
  // each game sees its own downloads; files fetched for no game in particular show under "all games"
  const downloads = scope === 'game' && game ? all.filter((d) => d.gameId === game.id) : all;
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
          <span className="muted" style={{ flex: '1 1 320px', minWidth: 0 }}>{t('Своих ограничений скорости нет. Файл делится на диапазоны и качается параллельными потоками; освободившийся поток забирает половину самого большого остатка.')}</span>
          {game && (
            <div className="seg" role="group" aria-label={t('Какие загрузки показывать')}>
              <button aria-pressed={scope === 'game'} onClick={() => setScope('game')}>
                {game.name}
              </button>
              <button aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
                {t('Все игры')}
              </button>
            </div>
          )}
          <button className="btn ghost" disabled={!all.some((d) => ['done', 'error', 'cancelled'].includes(d.state))} onClick={() => act('clear')}>
            {t('Очистить завершённые')}
          </button>
        </div>
        <div className="screen-scroll">
          <div className="dl-hero">
            <div className="card stat">
              <div className="label">{t('Скорость сейчас')}</div>
              <div className="value">
                {bytes(total).split(' ')[0]}
                <small>{bytes(total).split(' ')[1]}{t('/с')}</small>
              </div>
            </div>
            <div className="card stat">
              <div className="label">{t('Активных потоков')}</div>
              <div className="value">{conns}</div>
            </div>
            <div className="card stat">
              <div className="label">{t('Параллельных загрузок')}</div>
              <div className="row" style={{ marginTop: 6 }}>
                {settings && <Stepper value={settings.maxParallelDownloads} min={1} max={32} onChange={(v) => run(() => api.updateSettings({ maxParallelDownloads: v }))} />}
              </div>
            </div>
            <div className="card stat">
              <div className="label">{t('Потоков на файл')}</div>
              <div className="row" style={{ marginTop: 6 }}>
                {settings && <Stepper value={settings.maxConnectionsPerFile} min={1} max={32} onChange={(v) => run(() => api.updateSettings({ maxConnectionsPerFile: v }))} />}
              </div>
            </div>
          </div>
          {downloads.length === 0 ? (
            <Empty icon={<Download size={32} color="var(--text-3)" />} title={t("Загрузок пока не было")} text={t("Когда вы устанавливаете мод или коллекцию, файлы появятся здесь — с потоками, скоростью и проверкой хэша.")} />
          ) : (
            <div className="card">
              {downloads.map((d) => {
                const [tone, stateKey] = STATE[d.state];
                const word = t(stateKey);
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
                        <button className="btn ghost sm icon" aria-label={t("Пауза")} onClick={() => act('pause', d.id)}>
                          <Pause size={14} />
                        </button>
                      )}
                      {(d.state === 'paused' || d.state === 'error') && (
                        <button className="btn ghost sm icon" aria-label={t("Продолжить")} onClick={() => act('resume', d.id)}>
                          <Play size={14} />
                        </button>
                      )}
                      {d.state !== 'done' && d.state !== 'cancelled' && (
                        <button className="btn ghost sm icon" aria-label={t("Отменить")} onClick={() => act('cancel', d.id)}>
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
                          <span>{t('{0} пот.', d.connections)}</span>
                          <span>{t('осталось {0}', eta(d.size - d.received, d.speed))}</span>
                        </>
                      )}
                      <span>{d.rangeSupported ? t('{0} сегм.', d.segments.length) : t('один поток (сервер без Range)')}</span>
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
              {t('Проверено по хэшу: {0} из {1}. Файлы без хэша в источнике (Thunderstore, часть GitHub) проверяются только по размеру.', verified, done.length)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
