import { useEffect, useState } from 'react';
import { Download, FolderOpen, Moon, RefreshCw, ShieldCheck, Sun, Trash2, TriangleAlert, Upload } from 'lucide-react';
import type { SourceId } from '../../shared/types';
import { api, APP_VERSION, bridge } from '../api';
import { bytes, SOURCE_LABEL } from '../format';
import { useActive, useUI } from '../store';
import { Modal, Spinner, Stepper, Switch } from '../components/ui';
import { McContextFields } from '../sheets/ProfileSheet';
import { ChangeFolderSheet, viaLabel } from '../sheets/AddGameSheet';
import { getLang, LANGS, t, type Lang } from '../../shared/i18n';

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
        {t('Поиск, файлы и требования модов идут через открытый API Nexus. Для скачивания нужен вход в ваш аккаунт Nexus: с Premium файлы качаются напрямую в несколько потоков, без Premium — кнопкой «Mod Manager Download» на сайте и одним потоком, потому что скорость бесплатных аккаунтов Nexus ограничивает на своей стороне.')}
      </p>
      <div className="field">
        <div className="grow">
          {t('Аккаунт Nexus')}
          <small>
            {user ? (
              <>
                <b>{user.name}</b> · {user.premium ? 'Premium' : t('бесплатный')}. {t('Ключ зашифрован хранилищем Windows и не покидает этот компьютер.')}
              </>
            ) : sso ? (
              t('Откроется nexusmods.com: подтвердите доступ для Lattice, и вход завершится сам. Пароль Lattice не видит.')
            ) : (
              t('Тестовая сборка: вход через Nexus появится после регистрации Lattice в Nexus Mods. Пока можно вставить личный ключ (nexusmods.com → Site preferences → API Keys) — Nexus разрешает это только для тестирования.')
            )}
          </small>
        </div>
        {user ? (
          <button className="btn sm" onClick={() => run(() => api.clearNexusKey(), t('Nexus отвязан'))}>
            {t('Отвязать')}
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
            {busy && <Spinner />} {busy ? t('Ждём подтверждения на сайте…') : t('Войти через Nexus')}
          </button>
        ) : (
          <>
            <input className="input mono" type="password" placeholder={t("ключ")} value={key} onChange={(e) => setKey(e.target.value)} style={{ width: 200 }} aria-label={t("API-ключ Nexus")} />
            <button
              className="btn sm"
              disabled={!key.trim() || busy || !ack}
              title={ack ? undefined : t('Сначала отметьте, что понимаете риск')}
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
              {busy && <Spinner />} {t('Проверить и сохранить')}
            </button>
          </>
        )}
      </div>
      {sso === false && (
        <div className="risk-note" role="note">
          <TriangleAlert size={18} aria-hidden />
          <div className="grow">
            <b>{t('Личный ключ — на ваш страх и риск.')}</b> {t('Пока Lattice не зарегистрирован в Nexus Mods, их правила не разрешают использовать личные ключи в публичных приложениях. Nexus может отозвать ключ, ограничить или заблокировать аккаунт.')}{' '}
            <b>{t('Автор Lattice не несёт ответственности за эти и любые другие последствия.')}</b> {t('Modrinth, Thunderstore и GitHub работают без ключа.')}
            {!user && (
              <label className="row" style={{ marginTop: 8 }}>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                {t('Понимаю риск и использую свой ключ под свою ответственность')}
              </label>
            )}
          </div>
        </div>
      )}
      <div className="field">
        <div className="grow">
          {t('Открывать ссылки nxm:// в Lattice')}
          <small>{t('Тогда кнопка «Mod Manager Download» на сайте Nexus сразу строит план установки здесь. Lattice зарегистрируется как обработчик nxm:// в Windows.')}</small>
        </div>
        <Switch on={s.handleNxm} onChange={(v) => run(() => api.updateSettings({ handleNxm: v }))} label={t("Открывать ссылки nxm:// в Lattice")} />
      </div>
      <div className="field">
        <div className="grow">
          {t('Вставить ссылку nxm:// вручную')}
          <small>{t('Если обработчик выключен: скопируйте адрес кнопки «Mod Manager Download» и вставьте сюда.')}</small>
        </div>
        <input className="input mono" placeholder="nxm://…" value={nxm} onChange={(e) => setNxm(e.target.value)} style={{ width: 220 }} aria-label={t("Ссылка nxm")} />
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
          {t('Открыть')}
        </button>
      </div>
    </section>
  );
}

/** Space Lattice takes, and freeing what no profile, snapshot or open plan needs. */
function DiskField({ limit, onLimit }: { limit: number; onLimit: (v: number) => void }) {
  const run = useUI((x) => x.run);
  const [u, setU] = useState<Awaited<ReturnType<typeof api.diskUsage>> | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () =>
    api
      .diskUsage()
      .then(setU)
      .catch(() => setU(null));
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
    <div className="field">
      <div className="grow">
        {t('Место на диске')}
        <small>
          {u
            ? t('Скачанные файлы: {0} · подготовленные копии модов: {1} · не нужны ни одному профилю и снимку: {2}', bytes(u.downloads), bytes(u.staging), bytes(u.unused))
            : t('Считаем…')}
          {u && u.snapshots > 0 && (
            <>
              <br />
              {t('Ещё {0} держат только снимки: меньше снимков — меньше места.', bytes(u.snapshots))}
            </>
          )}
          {u && u.quarantine > 0 && (
            <>
              <br />
              {t('Карантин (файлы Vortex, убранные из игры): {0}. Хранится 7 дней, потом удаляется сам.', bytes(u.quarantine))}{' '}
              <button className="text-link" onClick={() => void bridge.openPath(u.quarantinePath)}>
                {t('Открыть')}
              </button>
            </>
          )}
          <br />
          {t('Ненужное Lattice убирает и сам: после удаления модов, профилей, коллекций и отменённых установок, а также при запуске.')}
        </small>
      </div>
      <button
        className="btn sm"
        disabled={!u || u.unusedCount === 0 || busy}
        onClick={async () => {
          setBusy(true);
          const r = await run(() => api.freeUnused());
          setBusy(false);
          if (r) useUI.getState().toast('ok', t('Освобождено: {0}', bytes(r.freed)));
          void load();
        }}
      >
        {busy && <Spinner />} {t('Освободить')}
      </button>
    </div>
    <div className="field">
      <div className="grow">
        {t('Снимков на профиль')}
        <small>{t('Самые старые снимки удаляются, когда их становится больше. Снимок держит файлы модов, чтобы откат работал без скачивания.')}</small>
      </div>
      <Stepper
        value={limit}
        min={3}
        max={100}
        onChange={(v) => {
          onLimit(v);
          setTimeout(() => void load(), 1500);
        }}
      />
    </div>
    </>
  );
}

/** A key or token: shown only as "saved", replaced or cleared. */
function SecretField({ label, hint, saved, placeholder, onSave }: { label: string; hint: string; saved: boolean; placeholder?: string; onSave: (v: string | undefined) => void | Promise<unknown> }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="field">
      <div className="grow">
        {label}
        <small>{hint}</small>
      </div>
      <input className="input mono" type="password" placeholder={saved ? t('•••••• сохранён') : (placeholder ?? '')} value={v} onChange={(e) => setV(e.target.value)} style={{ width: 200 }} aria-label={label} />
      <button
        className="btn sm"
        disabled={(!v && !saved) || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onSave(v.trim() || undefined);
            setV('');
          } catch {
            /* the reason is already shown; the text stays for correcting */
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy && <Spinner />} {v ? t('Сохранить') : t('Очистить')}
      </button>
    </div>
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
      <h2>{t('Порядок плагинов')}</h2>
      <p className="muted" style={{ margin: '0 0 8px' }}>
        {t('При развёртывании Lattice записывает его в {0}: сначала мастер-файлы, затем плагины в порядке модов и правил «до/после». Чужие записи остаются на месте, оригинал файла сохраняется и возвращается при очистке.', `%LOCALAPPDATA%\\${folder}\\plugins.txt`)}
      </p>
      {!list ? (
        <Spinner />
      ) : list.length === 0 ? (
        <span className="faint">{t('Включённые моды не содержат плагинов .esp/.esm/.esl.')}</span>
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
  const [moving, setMoving] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [mrUser, setMrUser] = useState(s?.modrinthUser ?? '');
  useEffect(() => setMrUser(s?.modrinthUser ?? ''), [s?.modrinthUser]);
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
              <h2>{t('Вид')}</h2>
              <div className="field">
                <div className="grow">
                  {t('Язык')}
                  {getLang() !== 'en' && ' · Language'}
                  <small>{t('Язык интерфейса. Выбирается при установке, здесь его можно сменить в любой момент.')}</small>
                </div>
                <select className="select" value={s.language ?? getLang()} onChange={(e) => set({ language: e.target.value as Lang })} aria-label={t('Язык')}>
                  {LANGS.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <div className="grow">{t('Тема')}</div>
                <div className="seg" role="group" aria-label={t("Тема")}>
                  <button aria-pressed={s.theme === 'dark'} onClick={() => set({ theme: 'dark' })}>
                    <Moon size={13} /> {t('Тёмная')}
                  </button>
                  <button aria-pressed={s.theme === 'light'} onClick={() => set({ theme: 'light' })}>
                    <Sun size={13} /> {t('Светлая')}
                  </button>
                </div>
              </div>
            </section>

            <section className="card card-pad section">
              <h2>{t('Загрузки')}</h2>
              <p className="muted" style={{ margin: '0 0 8px' }}>
                {t('Своего ограничения скорости в Lattice нет, все параметры ниже меняете вы. Источники, которые сами режут скорость на сервере, Lattice не обходит.')}
              </p>
              <div className="field">
                <div className="grow">
                  {t('Параллельных загрузок')}
                  <small>{t('Сколько файлов качается одновременно.')}</small>
                </div>
                <Stepper value={s.maxParallelDownloads} min={1} max={32} onChange={(v) => set({ maxParallelDownloads: v })} />
              </div>
              <div className="field">
                <div className="grow">
                  {t('Потоков на файл')}
                  <small>{t('Если сервер поддерживает HTTP Range, файл делится на части и качается этим числом соединений.')}</small>
                </div>
                <Stepper value={s.maxConnectionsPerFile} min={1} max={32} onChange={(v) => set({ maxConnectionsPerFile: v })} />
              </div>
              <div className="field">
                <div className="grow">
                  {t('Минимальный сегмент')}
                  <small>{t('Меньшие файлы качаются одним потоком: так быстрее, чем открывать много соединений.')}</small>
                </div>
                <Stepper value={s.minSegmentMiB} min={0.25} max={64} step={0.25} suffix={t(" МиБ")} onChange={(v) => set({ minSegmentMiB: v })} />
              </div>
            </section>

            <section className="card card-pad section">
              <h2>{t('Совместимость и развёртывание')}</h2>
              <div className="field">
                <div className="grow">
                  {t('Ставить рекомендованные зависимости')}
                  <small>{t('Иначе они только предлагаются в плане установки.')}</small>
                </div>
                <Switch on={s.includeRecommended} onChange={(v) => set({ includeRecommended: v })} label={t("Ставить рекомендованные зависимости")} />
              </div>
              <div className="field">
                <div className="grow">
                  {t('Способ развёртывания')}
                  <small>{t('Жёсткие ссылки не занимают место повторно. Если папка игры на другом диске, Lattice сам переключится на копии.')}</small>
                </div>
                <div className="seg" role="group" aria-label={t("Способ развёртывания")}>
                  <button aria-pressed={s.deployMethod === 'hardlink'} onClick={() => set({ deployMethod: 'hardlink' })}>
                    {t('Жёсткие ссылки')}
                  </button>
                  <button aria-pressed={s.deployMethod === 'copy'} onClick={() => set({ deployMethod: 'copy' })}>
                    {t('Копии')}
                  </button>
                </div>
              </div>
            </section>

            <section className="card card-pad section">
              <h2>{t('Источники')}</h2>
              {(['modrinth', 'curseforge', 'thunderstore', 'nexus', 'gamebanana', 'github'] as SourceId[]).map((src) => (
                <div className="field" key={src}>
                  <div className="grow">{SOURCE_LABEL[src]}</div>
                  <Switch on={s.enabledSources[src]} onChange={(v) => set({ enabledSources: { ...s.enabledSources, [src]: v } })} label={SOURCE_LABEL[src]} />
                </div>
              ))}
              <div className="field">
                <div className="grow">
                  {t('Токен GitHub')}
                  <small>{t('Необязателен. Поднимает лимит запросов к API GitHub. Хранится только на этом компьютере.')}</small>
                </div>
                <input className="input mono" type="password" placeholder={s.githubToken ? t('•••••• сохранён') : 'ghp_…'} value={token} onChange={(e) => setToken(e.target.value)} style={{ width: 200 }} aria-label={t("Токен GitHub")} />
                <button
                  className="btn sm"
                  onClick={() => {
                    void set({ githubToken: token.trim() || undefined });
                    setToken('');
                  }}
                >
                  {token ? t('Сохранить') : t('Очистить')}
                </button>
              </div>
              <SecretField
                label={t('Ключ CurseForge')}
                hint={t('CurseForge открывает поиск и скачивание только по ключу API, который выдаёт сам (console.curseforge.com). Аккаунтов для сторонних программ у CurseForge нет. Хранится только на этом компьютере.')}
                saved={!!s.curseforgeKey}
                onSave={async (v) => {
                  if (!v) return set({ curseforgeKey: undefined });
                  // the key is tried first: a wrong one is not saved
                  const r = await run(() => api.curseforgeCheck(v));
                  if (!r) throw new Error('rejected');
                  await set({ curseforgeKey: v });
                  useUI.getState().toast('ok', t('CurseForge принял ключ: доступно игр — {0}', r.games));
                }}
              />
              <div className="field">
                <div className="grow">
                  {t('Аккаунт Modrinth')}
                  <small>{t('Имя пользователя показывает ваши публичные коллекции в «Обзоре». Токен (modrinth.com → Settings → Personal access tokens, только чтение) добавляет приватные коллекции и подписки.')}</small>
                </div>
                <input className="input" placeholder={t('имя пользователя')} value={mrUser} onChange={(e) => setMrUser(e.target.value)} style={{ width: 150 }} aria-label={t('Имя пользователя Modrinth')} />
                <button className="btn sm" disabled={mrUser === (s.modrinthUser ?? '')} onClick={() => set({ modrinthUser: mrUser.trim() || undefined })}>
                  {t('Сохранить')}
                </button>
              </div>
              <SecretField label={t('Токен Modrinth')} hint={t('Необязателен. Хранится только на этом компьютере.')} saved={!!s.modrinthToken} placeholder="mrp_…" onSave={(v) => set({ modrinthToken: v })} />
              <div className="field" style={{ alignItems: 'flex-start' }}>
                <div className="grow">
                  {t('Доверенные хосты')}
                  <small>{t('Файлы скачиваются только по HTTPS и только с этих доменов (и их поддоменов). Хэши проверяются, если источник их даёт.')}</small>
                </div>
                <div className="col" style={{ width: 260 }}>
                  <textarea className="input mono" rows={6} value={hosts} onChange={(e) => setHosts(e.target.value)} aria-label={t("Доверенные хосты")} />
                  <button className="btn sm" style={{ alignSelf: 'flex-end' }} onClick={() => set({ trustedHosts: hosts.split(/\s+/) })}>
                    {t('Сохранить список')}
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
                    {t('Папка игры')}
                    {game.install && (game.install.launcher || game.install.store) && (
                      <span className="chip outline" style={{ marginLeft: 8 }}>
                        {viaLabel(game.install.launcher ?? game.install.store)}
                      </span>
                    )}
                    <small className="mono">{game.installPath}</small>
                  </div>
                  <button className="btn sm" onClick={() => bridge.openPath(game.installPath)}>
                    <FolderOpen size={13} /> {t('Открыть')}
                  </button>
                  <button
                    className="btn sm"
                    title={t("Если игра переехала или Lattice нашёл не ту папку")}
                    onClick={() => setMoving(true)}
                  >
                    {t('Сменить папку')}
                  </button>
                  {moving && <ChangeFolderSheet game={game} onClose={() => setMoving(false)} />}
                </div>
                <div className="field">
                  <div className="grow">
                    {t('Чем запускать')}
                    <small>
                      {game.install?.launcherExe ? (
                        <span className="mono">{game.install.launcherExe}</span>
                      ) : def?.kind === 'minecraft' ? (
                        t('Exe лаунчера не найден: «Играть» поставит загрузчик и подскажет, что выбрать. Укажите его, чтобы Lattice открывал лаунчер сам.')
                      ) : (
                        t('Определяется само: Steam, Epic, exe игры или загрузчик модов.')
                      )}
                      {game.install?.customExe && <> · {t('выбрано вручную')}</>}
                    </small>
                  </div>
                  <button
                    className="btn sm"
                    onClick={async () => {
                      const exe = await bridge.dialog('exe');
                      if (exe) await run(() => api.setLauncherExe(game.id, exe), t('Lattice будет запускать: {0}', exe.split(/[\\/]/).pop() ?? exe));
                    }}
                  >
                    {t('Указать exe…')}
                  </button>
                  {game.install?.customExe && (
                    <button className="btn sm ghost" onClick={() => run(() => api.setLauncherExe(game.id, null), t('Запуск снова определяется сам'))}>
                      {t('Сбросить')}
                    </button>
                  )}
                </div>
                <div className="field">
                  <div className="grow">
                    {t('Название профиля')}
                    <small>{t('Активный профиль этой игры.')}</small>
                  </div>
                  <input className="input" value={pname} onChange={(e) => setPname(e.target.value)} aria-label={t("Название профиля")} />
                  <button className="btn sm" disabled={!pname.trim() || pname === profile.name} onClick={() => run(() => api.updateProfile(profile.id, { name: pname.trim() }))}>
                    {t('Сохранить')}
                  </button>
                </div>
                {def?.kind === 'minecraft' && (
                  <div className="field" style={{ alignItems: 'flex-start' }}>
                    <div className="grow">
                      {t('Версия и загрузчик профиля')}
                      <small>{t('Lattice сразу перепроверит все моды. Что не подходит, будет отмечено, а исправить можно через безопасное обновление.')}</small>
                    </div>
                    <div className="form-grid" style={{ gridTemplateColumns: '100px 160px' }}>
                      <McContextFields version={profile.context.gameVersion} loader={profile.context.loader} onChange={(c) => run(() => api.updateProfile(profile.id, { context: c }))} />
                    </div>
                  </div>
                )}
                <div className="field">
                  <div className="grow">
                    {t('Убрать моды из папки игры')}
                    <small>{t('Удаляет развёрнутые файлы и возвращает оригиналы игры. Профиль и загрузки не трогает.')}</small>
                  </div>
                  <button className="btn sm" onClick={() => run(() => api.purge(game.id), t('Папка игры очищена'))}>
                    {t('Очистить')}
                  </button>
                </div>
                <div className="field">
                  <div className="grow">
                    {t('Экспорт профиля')}
                    <small>{t('Файл с точными версиями модов, правилами и опциями установщиков. Его можно открыть на другом компьютере: Коллекции → Импорт.')}</small>
                  </div>
                  <button
                    className="btn sm"
                    onClick={async () => {
                      const file = await bridge.dialog('collection-save', `${profile.name.replace(/[\\/:*?"<>|]+/g, '_')}.lattice.json`);
                      if (file) await run(() => api.exportProfile(profile.id, file));
                    }}
                  >
                    <Download size={13} /> {t('Экспорт…')}
                  </button>
                </div>
                <div className="field">
                  <div className="grow">{t('Удалить профиль «{0}»', profile.name)}</div>
                  <button className="btn sm danger" onClick={() => run(() => api.deleteProfile(profile.id), t('Профиль удалён'))}>
                    <Trash2 size={13} /> {t('Удалить профиль')}
                  </button>
                </div>
                <div className="field">
                  <div className="grow">
                    {t('Убрать игру из Lattice')}
                    <small>{t('Сначала очищает папку игры. Скачанные файлы остаются в кэше.')}</small>
                  </div>
                  <button className="btn sm danger" onClick={() => run(() => api.removeGame(game.id), t('Игра убрана'))}>
                    {t('Убрать игру')}
                  </button>
                </div>
              </section>
            )}
            <section className="card card-pad section">
              <h2>{t('Обслуживание')}</h2>
              <div className="field">
                <div className="grow">
                  {t('Проверить целостность')}
                  <small>{t('Ищет пропавшие файлы модов в папке игры, повреждённые копии, недокачанные загрузки и циклы в порядке загрузки. То же происходит при каждом запуске.')}</small>
                </div>
                <button className="btn sm" onClick={() => void useUI.getState().checkHealth(true)}>
                  <ShieldCheck size={13} /> {t('Проверить')}
                </button>
              </div>
              <DiskField limit={s.snapshotLimit ?? 30} onLimit={(v) => set({ snapshotLimit: v })} />
              <div className="field">
                <div className="grow">
                  {t('Обновления Lattice')}
                  <small>
                    {t('Версия {0}. Новые версии берутся из релизов на GitHub. При запуске Lattice спрашивает, обновляться ли; «Не предлагать 7 дней» откладывает вопрос.', APP_VERSION)}
                  </small>
                </div>
                <button className="btn sm" onClick={() => bridge.update('check').catch((e) => useUI.getState().toast('err', (e as Error).message))}>
                  <RefreshCw size={13} /> {t('Проверить обновления')}
                </button>
              </div>
              <div className="field">
                <div className="grow">
                  {t('Резервная копия')}
                  <small>{t('Игры, профили, коллекции, снимки и настройки в одном файле. Ключи и сами файлы модов в копию не входят: при восстановлении Lattice скачает недостающее.')}</small>
                </div>
                <button
                  className="btn sm"
                  onClick={async () => {
                    const file = await bridge.dialog('backup-save', `lattice-backup-${new Date().toISOString().slice(0, 10)}.json`);
                    if (!file) return;
                    const r = await run(() => api.backupAll(file));
                    if (r) useUI.getState().toast('ok', t('Копия сохранена: игр {0}, профилей {1}, коллекций {2}', r.games, r.profiles, r.collections));
                  }}
                >
                  <Download size={13} /> {t('Сохранить…')}
                </button>
                <button
                  className="btn sm"
                  onClick={async () => {
                    const file = await bridge.dialog('backup-open');
                    if (file) setRestoring(file);
                  }}
                >
                  <Upload size={13} /> {t('Восстановить…')}
                </button>
              </div>
            </section>
            {restoring && (
              <Modal
                title={t('Восстановить из копии?')}
                sub={t('Игры, профили, коллекции и снимки заменятся содержимым файла. Текущее состояние Lattice сохранится рядом как state.json.before-restore.')}
                onClose={() => setRestoring(null)}
                size="sm"
                foot={
                  <>
                    <span className="grow" />
                    <button className="btn ghost" onClick={() => setRestoring(null)}>
                      {t('Отмена')}
                    </button>
                    <button
                      className="btn primary"
                      onClick={async () => {
                        const file = restoring;
                        setRestoring(null);
                        const r = await run(() => api.restoreBackup(file));
                        if (r) {
                          useUI.getState().toast('ok', t('Восстановлено: игр {0}, профилей {1}', r.games, r.profiles));
                          void useUI.getState().checkHealth(true);
                        }
                      }}
                    >
                      {t('Восстановить')}
                    </button>
                  </>
                }
              >
                <span className="mono faint">{restoring}</span>
              </Modal>
            )}
            <p className="faint mono" style={{ fontSize: 11 }}>
              {t('Данные:')} {s.dataRoot}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
