import { useEffect, useState } from 'react';
import { FolderOpen, Moon, RefreshCw, ShieldCheck, Sun, Trash2, TriangleAlert } from 'lucide-react';
import type { SourceId } from '../../shared/types';
import { api, APP_VERSION, bridge } from '../api';
import { SOURCE_LABEL } from '../format';
import { useActive, useUI } from '../store';
import { Spinner, Stepper, Switch } from '../components/ui';
import { McContextFields } from '../sheets/ProfileSheet';

function NexusSection() {
  const s = useUI((x) => x.state?.settings);
  const run = useUI((x) => x.run);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [nxm, setNxm] = useState('');
  const [sso, setSso] = useState<boolean | null>(null);
  const [ack, setAck] = useState(false);
  useEffect(() => {
    api
      .nexusSsoAvailable()
      .then(setSso)
      .catch(() => setSso(false));
  }, []);
  if (!s) return null;
  const user = s.nexusUser;
  return (
    <section className="card card-pad section">
      <h2>Nexus Mods</h2>
      <p className="muted" style={{ margin: '0 0 8px' }}>
        Поиск, файлы и требования модов идут через открытый API Nexus. Для скачивания нужен вход в ваш аккаунт Nexus: с Premium файлы качаются
        напрямую в несколько потоков, без Premium — кнопкой «Mod Manager Download» на сайте и одним потоком, потому что скорость бесплатных аккаунтов
        Nexus ограничивает на своей стороне.
      </p>
      <div className="field">
        <div className="grow">
          Аккаунт Nexus
          <small>
            {user ? (
              <>
                <b>{user.name}</b> · {user.premium ? 'Premium' : 'бесплатный'}. Ключ зашифрован хранилищем Windows и не покидает этот компьютер.
              </>
            ) : sso ? (
              'Откроется nexusmods.com: подтвердите доступ для Lattice, и вход завершится сам. Пароль Lattice не видит.'
            ) : (
              'Тестовая сборка: вход через Nexus появится после регистрации Lattice в Nexus Mods. Пока можно вставить личный ключ (nexusmods.com → Site preferences → API Keys) — Nexus разрешает это только для тестирования.'
            )}
          </small>
        </div>
        {user ? (
          <button className="btn sm" onClick={() => run(() => api.clearNexusKey(), 'Nexus отвязан')}>
            Отвязать
          </button>
        ) : sso ? (
          <button
            className="btn primary sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const u = await run(() => api.loginWithNexus());
              setBusy(false);
              if (u) useUI.getState().toast('ok', `Nexus: ${u.name}${u.premium ? ', Premium' : ''}`);
            }}
          >
            {busy && <Spinner />} {busy ? 'Ждём подтверждения на сайте…' : 'Войти через Nexus'}
          </button>
        ) : (
          <>
            <input className="input mono" type="password" placeholder="ключ" value={key} onChange={(e) => setKey(e.target.value)} style={{ width: 200 }} aria-label="API-ключ Nexus" />
            <button
              className="btn sm"
              disabled={!key.trim() || busy || !ack}
              title={ack ? undefined : 'Сначала отметьте, что понимаете риск'}
              onClick={async () => {
                setBusy(true);
                const u = await run(() => api.setNexusKey(key));
                setBusy(false);
                if (u) {
                  setKey('');
                  useUI.getState().toast('ok', `Nexus: ${u.name}${u.premium ? ', Premium' : ''}`);
                }
              }}
            >
              {busy && <Spinner />} Проверить и сохранить
            </button>
          </>
        )}
      </div>
      {sso === false && (
        <div className="risk-note" role="note">
          <TriangleAlert size={18} aria-hidden />
          <div className="grow">
            <b>Личный ключ — на ваш страх и риск.</b> Пока Lattice не зарегистрирован в Nexus Mods, их правила не разрешают использовать личные
            ключи в публичных приложениях. Nexus может отозвать ключ, ограничить или заблокировать аккаунт.{' '}
            <b>Автор Lattice не несёт ответственности</b> за эти и любые другие последствия. Modrinth, Thunderstore и GitHub работают без ключа.
            {!user && (
              <label className="row" style={{ marginTop: 8 }}>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                Понимаю риск и использую свой ключ под свою ответственность
              </label>
            )}
          </div>
        </div>
      )}
      <div className="field">
        <div className="grow">
          Открывать ссылки nxm:// в Lattice
          <small>Тогда кнопка «Mod Manager Download» на сайте Nexus сразу строит план установки здесь. Lattice зарегистрируется как обработчик nxm:// в Windows.</small>
        </div>
        <Switch on={s.handleNxm} onChange={(v) => run(() => api.updateSettings({ handleNxm: v }))} label="Открывать ссылки nxm:// в Lattice" />
      </div>
      <div className="field">
        <div className="grow">
          Вставить ссылку nxm:// вручную
          <small>Если обработчик выключен: скопируйте адрес кнопки «Mod Manager Download» и вставьте сюда.</small>
        </div>
        <input className="input mono" placeholder="nxm://…" value={nxm} onChange={(e) => setNxm(e.target.value)} style={{ width: 220 }} aria-label="Ссылка nxm" />
        <button
          className="btn sm"
          disabled={!/^nxm:\/\//i.test(nxm.trim())}
          onClick={async () => {
            const plan = await run(() => api.handleNxm(nxm.trim()));
            if (plan) {
              setNxm('');
              useUI.setState({ plan });
            }
          }}
        >
          Открыть
        </button>
      </div>
    </section>
  );
}

function PluginOrder({ profileId, folder }: { profileId: string; folder: string }) {
  const state = useUI((x) => x.state);
  const [list, setList] = useState<Awaited<ReturnType<typeof api.pluginOrder>> | null>(null);
  useEffect(() => {
    api
      .pluginOrder(profileId)
      .then(setList)
      .catch(() => setList([]));
  }, [profileId, state]);
  return (
    <section className="card card-pad section">
      <h2>Порядок плагинов</h2>
      <p className="muted" style={{ margin: '0 0 8px' }}>
        При развёртывании Lattice записывает его в %LOCALAPPDATA%\{folder}\plugins.txt: сначала мастер-файлы, затем плагины в порядке модов и правил «до/после».
        Чужие записи остаются на месте, оригинал файла сохраняется и возвращается при очистке.
      </p>
      {!list ? (
        <Spinner />
      ) : list.length === 0 ? (
        <span className="faint">Включённые моды не содержат плагинов .esp/.esm/.esl.</span>
      ) : (
        <ol className="link-list" style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
          {list.map((p, i) => (
            <li className="link-item" key={`${p.owner}${p.name}`}>
              <span className="mono faint" style={{ width: 28 }}>
                {String(i).padStart(2, '0')}
              </span>
              <span className="grow ellipsis mono">{p.name}</span>
              <span className="faint ellipsis" style={{ maxWidth: 220 }}>
                {p.title}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function Settings() {
  const { state, game, profile, def } = useActive();
  const run = useUI((s) => s.run);
  const s = state?.settings;
  const [hosts, setHosts] = useState('');
  const [token, setToken] = useState('');
  const [pname, setPname] = useState(profile?.name ?? '');
  useEffect(() => setHosts(s?.trustedHosts.join('\n') ?? ''), [s?.trustedHosts]);
  useEffect(() => setPname(profile?.name ?? ''), [profile?.id, profile?.name]);
  if (!s) return null;
  const set = (patch: Parameters<typeof api.updateSettings>[0]) => run(() => api.updateSettings(patch));

  return (
    <div className="content">
      <div className="screen">
        <div className="screen-scroll">
          <div className="settings">
            <section className="card card-pad section">
              <h2>Вид</h2>
              <div className="field">
                <div className="grow">Тема</div>
                <div className="seg" role="group" aria-label="Тема">
                  <button aria-pressed={s.theme === 'dark'} onClick={() => set({ theme: 'dark' })}>
                    <Moon size={13} /> Тёмная
                  </button>
                  <button aria-pressed={s.theme === 'light'} onClick={() => set({ theme: 'light' })}>
                    <Sun size={13} /> Светлая
                  </button>
                </div>
              </div>
            </section>

            <section className="card card-pad section">
              <h2>Загрузки</h2>
              <p className="muted" style={{ margin: '0 0 8px' }}>
                Своего ограничения скорости в Lattice нет, все параметры ниже меняете вы. Источники, которые сами режут скорость на сервере, Lattice не обходит.
              </p>
              <div className="field">
                <div className="grow">
                  Параллельных загрузок
                  <small>Сколько файлов качается одновременно.</small>
                </div>
                <Stepper value={s.maxParallelDownloads} min={1} max={32} onChange={(v) => set({ maxParallelDownloads: v })} />
              </div>
              <div className="field">
                <div className="grow">
                  Потоков на файл
                  <small>Если сервер поддерживает HTTP Range, файл делится на части и качается этим числом соединений.</small>
                </div>
                <Stepper value={s.maxConnectionsPerFile} min={1} max={32} onChange={(v) => set({ maxConnectionsPerFile: v })} />
              </div>
              <div className="field">
                <div className="grow">
                  Минимальный сегмент
                  <small>Меньшие файлы качаются одним потоком: так быстрее, чем открывать много соединений.</small>
                </div>
                <Stepper value={s.minSegmentMiB} min={0.25} max={64} step={0.25} suffix=" МиБ" onChange={(v) => set({ minSegmentMiB: v })} />
              </div>
            </section>

            <section className="card card-pad section">
              <h2>Совместимость и развёртывание</h2>
              <div className="field">
                <div className="grow">
                  Ставить рекомендованные зависимости
                  <small>Иначе они только предлагаются в плане установки.</small>
                </div>
                <Switch on={s.includeRecommended} onChange={(v) => set({ includeRecommended: v })} label="Ставить рекомендованные зависимости" />
              </div>
              <div className="field">
                <div className="grow">
                  Способ развёртывания
                  <small>Жёсткие ссылки не занимают место повторно. Если папка игры на другом диске, Lattice сам переключится на копии.</small>
                </div>
                <div className="seg" role="group" aria-label="Способ развёртывания">
                  <button aria-pressed={s.deployMethod === 'hardlink'} onClick={() => set({ deployMethod: 'hardlink' })}>
                    Жёсткие ссылки
                  </button>
                  <button aria-pressed={s.deployMethod === 'copy'} onClick={() => set({ deployMethod: 'copy' })}>
                    Копии
                  </button>
                </div>
              </div>
            </section>

            <section className="card card-pad section">
              <h2>Источники</h2>
              {(['modrinth', 'thunderstore', 'nexus', 'github'] as SourceId[]).map((src) => (
                <div className="field" key={src}>
                  <div className="grow">{SOURCE_LABEL[src]}</div>
                  <Switch on={s.enabledSources[src]} onChange={(v) => set({ enabledSources: { ...s.enabledSources, [src]: v } })} label={SOURCE_LABEL[src]} />
                </div>
              ))}
              <div className="field">
                <div className="grow">
                  Токен GitHub
                  <small>Необязателен. Поднимает лимит запросов к API GitHub. Хранится только на этом компьютере.</small>
                </div>
                <input className="input mono" type="password" placeholder={s.githubToken ? '•••••• сохранён' : 'ghp_…'} value={token} onChange={(e) => setToken(e.target.value)} style={{ width: 200 }} aria-label="Токен GitHub" />
                <button
                  className="btn sm"
                  onClick={() => {
                    void set({ githubToken: token.trim() || undefined });
                    setToken('');
                  }}
                >
                  {token ? 'Сохранить' : 'Очистить'}
                </button>
              </div>
              <div className="field" style={{ alignItems: 'flex-start' }}>
                <div className="grow">
                  Доверенные хосты
                  <small>Файлы скачиваются только по HTTPS и только с этих доменов (и их поддоменов). Хэши проверяются, если источник их даёт.</small>
                </div>
                <div className="col" style={{ width: 260 }}>
                  <textarea className="input mono" rows={6} value={hosts} onChange={(e) => setHosts(e.target.value)} aria-label="Доверенные хосты" />
                  <button className="btn sm" style={{ alignSelf: 'flex-end' }} onClick={() => set({ trustedHosts: hosts.split(/\s+/) })}>
                    Сохранить список
                  </button>
                </div>
              </div>
            </section>

            <NexusSection />

            {game && profile && def?.pluginsTxt && <PluginOrder profileId={profile.id} folder={def.pluginsTxt.folder} />}

            {game && profile && (
              <section className="card card-pad section">
                <h2>{game.name}</h2>
                <div className="field">
                  <div className="grow">
                    Папка игры
                    <small className="mono">{game.installPath}</small>
                  </div>
                  <button className="btn sm" onClick={() => bridge.openPath(game.installPath)}>
                    <FolderOpen size={13} /> Открыть
                  </button>
                  <button
                    className="btn sm"
                    title="Если игра переехала или Lattice нашёл не ту папку"
                    onClick={async () => {
                      const dir = await bridge.dialog('folder');
                      if (dir) await run(() => api.setGamePath(game.id, dir), 'Папка игры изменена, моды применены заново');
                    }}
                  >
                    Сменить папку
                  </button>
                </div>
                <div className="field">
                  <div className="grow">
                    Название профиля
                    <small>Активный профиль этой игры.</small>
                  </div>
                  <input className="input" value={pname} onChange={(e) => setPname(e.target.value)} aria-label="Название профиля" />
                  <button className="btn sm" disabled={!pname.trim() || pname === profile.name} onClick={() => run(() => api.updateProfile(profile.id, { name: pname.trim() }))}>
                    Сохранить
                  </button>
                </div>
                {def?.kind === 'minecraft' && (
                  <div className="field" style={{ alignItems: 'flex-start' }}>
                    <div className="grow">
                      Версия и загрузчик профиля
                      <small>Lattice сразу перепроверит все моды. Что не подходит, будет отмечено, а исправить можно через безопасное обновление.</small>
                    </div>
                    <div className="form-grid" style={{ gridTemplateColumns: '100px 160px' }}>
                      <McContextFields version={profile.context.gameVersion} loader={profile.context.loader} onChange={(c) => run(() => api.updateProfile(profile.id, { context: c }))} />
                    </div>
                  </div>
                )}
                <div className="field">
                  <div className="grow">
                    Убрать моды из папки игры
                    <small>Удаляет развёрнутые файлы и возвращает оригиналы игры. Профиль и загрузки не трогает.</small>
                  </div>
                  <button className="btn sm" onClick={() => run(() => api.purge(game.id), 'Папка игры очищена')}>
                    Очистить
                  </button>
                </div>
                <div className="field">
                  <div className="grow">Удалить профиль «{profile.name}»</div>
                  <button className="btn sm danger" onClick={() => run(() => api.deleteProfile(profile.id), 'Профиль удалён')}>
                    <Trash2 size={13} /> Удалить профиль
                  </button>
                </div>
                <div className="field">
                  <div className="grow">
                    Убрать игру из Lattice
                    <small>Сначала очищает папку игры. Скачанные файлы остаются в кэше.</small>
                  </div>
                  <button className="btn sm danger" onClick={() => run(() => api.removeGame(game.id), 'Игра убрана')}>
                    Убрать игру
                  </button>
                </div>
              </section>
            )}
            <section className="card card-pad section">
              <h2>Обслуживание</h2>
              <div className="field">
                <div className="grow">
                  Проверить целостность
                  <small>Ищет пропавшие файлы модов в папке игры, повреждённые копии, недокачанные загрузки и циклы в порядке загрузки. То же происходит при каждом запуске.</small>
                </div>
                <button className="btn sm" onClick={() => void useUI.getState().checkHealth(true)}>
                  <ShieldCheck size={13} /> Проверить
                </button>
              </div>
              <div className="field">
                <div className="grow">
                  Обновления Lattice
                  <small>
                    Версия {APP_VERSION}. Новые версии берутся из релизов на GitHub. При запуске Lattice спрашивает, обновляться ли; «Не предлагать 7 дней» откладывает вопрос.
                  </small>
                </div>
                <button className="btn sm" onClick={() => bridge.update('check').catch((e) => useUI.getState().toast('err', (e as Error).message))}>
                  <RefreshCw size={13} /> Проверить обновления
                </button>
              </div>
            </section>
            <p className="faint mono" style={{ fontSize: 11 }}>
              Данные: {s.dataRoot}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
