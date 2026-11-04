import { useEffect, useState } from 'react';
import { ArrowRightLeft, TriangleAlert } from 'lucide-react';
import { api } from '../api';
import { plural } from '../format';
import { useActive, useUI } from '../store';
import { Empty, Modal, Spinner } from '../components/ui';
import { t } from '../../shared/i18n';

type Sources = Awaited<ReturnType<typeof api.scanImports>>;

const MANAGER: Record<string, string> = { vortex: 'Vortex', mo2: 'Mod Organizer 2', r2modman: 'r2modman / Thunderstore Mod Manager' };

function profileLabel(manager: string, id: string, name: string) {
  if (manager === 'vortex' && id === 'deployed') return t('Сейчас в игре (активный профиль Vortex)');
  if (manager === 'vortex' && id === 'all') return t('Все моды из папки Vortex');
  return name;
}

function problemLabel(p: string) {
  if (p === 'outside') return t('файлы лежат вне папки, куда Lattice ставит моды');
  if (p === 'root') return t('есть папка Root (Root Builder): её файлы Lattice не переносит');
  return p;
}

/**
 * Moving a setup over from Vortex, Mod Organizer 2 or r2modman: pick one of
 * its profiles; the result is a plan in a new Lattice profile, with what is
 * missing for the game to start.
 */
export function ImportSheet({ onClose }: { onClose: () => void }) {
  const { game } = useActive();
  const run = useUI((s) => s.run);
  const [sources, setSources] = useState<Sources | null>(null);
  const [pick, setPick] = useState<{ source: string; profile: string } | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!game) return;
    api
      .scanImports(game.id)
      .then((s) => {
        setSources(s);
        const first = s[0]?.profiles[0];
        if (first) {
          setPick({ source: s[0].id, profile: first.id });
          setName(`${MANAGER[s[0].manager].split(' /')[0]} · ${profileLabel(s[0].manager, first.id, first.name)}`);
        }
      })
      .catch(() => setSources([]));
  }, [game?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!game) return null;
  const src = sources?.find((s) => s.id === pick?.source);

  const go = async () => {
    if (!pick) return;
    setBusy(true);
    const plan = await run(() => api.importPlan(game.id, pick.source, pick.profile, name.trim()));
    setBusy(false);
    if (plan) {
      useUI.setState({ plan, planning: null });
      onClose();
    }
  };

  return (
    <Modal
      title={t('Перенос из других менеджеров')}
      sub={t('Файлы модов берутся из папок Vortex и Mod Organizer 2 без повторного скачивания, моды сверяются с Nexus и Thunderstore. План покажет, чего не хватает для запуска, до того как что-то установится.')}
      onClose={busy ? () => undefined : onClose}
      foot={
        <>
          <span className="grow faint">{busy ? t('Сверяем моды с Nexus и Thunderstore…') : src?.deployedFiles ? t('Перед включением нового профиля нажмите Purge в Vortex.') : ''}</span>
          <button className="btn ghost" disabled={busy} onClick={onClose}>
            {t('Отмена')}
          </button>
          <button className="btn primary" disabled={!pick || busy} onClick={go}>
            {busy ? <Spinner /> : <ArrowRightLeft size={15} />} {t('Перенести и проверить связи')}
          </button>
        </>
      }
    >
      {sources === null ? (
        <span className="row">
          <Spinner /> {t('Ищем Vortex, Mod Organizer 2 и r2modman…')}
        </span>
      ) : sources.length === 0 ? (
        <Empty
          title={t('Для этой игры ничего не найдено')}
          text={t('Lattice ищет папку модов Vortex (её путь записан в vortex.deployment.json в папке игры и в папке Vortex), экземпляры Mod Organizer 2 и профили r2modman и Thunderstore Mod Manager.')}
        />
      ) : (
        <>
          {sources.map((s) => (
            <div key={s.id} className="card card-pad col" style={{ gap: 8 }}>
              <div className="row">
                <b className="grow">{MANAGER[s.manager]}</b>
                {s.deployedFiles > 0 && (
                  <span className="chip warn" title={t('Vortex держит эти файлы в папке игры. Lattice не станет класть свои поверх: сначала нажмите Purge в Vortex.')}>
                    <TriangleAlert size={12} /> {t('в игре файлов Vortex: {0}', s.deployedFiles)}
                  </span>
                )}
              </div>
              <small className="mono faint ellipsis" title={s.path}>
                {s.path}
              </small>
              <div className="copy-list" role="radiogroup">
                {s.profiles.map((p) => {
                  const on = pick?.source === s.id && pick.profile === p.id;
                  return (
                    <button
                      key={p.id}
                      role="radio"
                      aria-checked={on}
                      className="copy"
                      onClick={() => {
                        setPick({ source: s.id, profile: p.id });
                        setName(`${MANAGER[s.manager].split(' /')[0]} · ${profileLabel(s.manager, p.id, p.name)}`);
                      }}
                    >
                      <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                        <b className="ellipsis">{profileLabel(s.manager, p.id, p.name)}</b>
                        <small className="faint">
                          {plural(p.count, 'мод', 'мода', 'модов')} · {t('узнано по Nexus или Thunderstore: {0}', p.known)}
                        </small>
                        {p.skipped.length > 0 && (
                          <small style={{ color: 'var(--warn)' }}>
                            {t('Не перенесутся: {0}', p.skipped.map((x) => `«${x.name}» (${problemLabel(x.problem)})`).join(', '))}
                          </small>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="form-grid">
            <label htmlFor="imp-name">{t('Новый профиль')}</label>
            <input id="imp-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </>
      )}
    </Modal>
  );
}
