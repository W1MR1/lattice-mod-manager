import { useEffect, useState } from 'react';
import { api } from '../api';
import { LOADER_LABEL } from '../format';
import { useActive, useUI } from '../store';
import { Modal, Switch } from '../components/ui';
import { t } from '../../shared/i18n';

export function McContextFields({ version, loader, onChange }: { version?: string; loader?: string; onChange: (v: { gameVersion?: string; loader?: string }) => void }) {
  const [versions, setVersions] = useState<string[]>([]);
  useEffect(() => {
    api
      .minecraftVersions()
      .then(setVersions)
      .catch(() => setVersions(['1.21.4', '1.21.1', '1.20.6', '1.20.4', '1.20.1', '1.19.2', '1.18.2', '1.16.5']));
  }, []);
  const list = version && !versions.includes(version) ? [version, ...versions] : versions;
  return (
    <>
      <label htmlFor="mc-ver">{t('Версия игры')}</label>
      <select id="mc-ver" className="select" value={version ?? ''} onChange={(e) => onChange({ gameVersion: e.target.value || undefined, loader })}>
        <option value="">{t('— любая —')}</option>
        {list.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
      <label htmlFor="mc-loader">{t('Загрузчик')}</label>
      <select id="mc-loader" className="select" value={loader ?? 'fabric'} onChange={(e) => onChange({ gameVersion: version, loader: e.target.value })}>
        {Object.entries(LOADER_LABEL).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
    </>
  );
}

export function ProfileSheet({ gameId, onClose }: { gameId: string; onClose: () => void }) {
  const { profile, def } = useActive();
  const run = useUI((s) => s.run);
  const [name, setName] = useState('');
  const [copy, setCopy] = useState(false);
  const [ctx, setCtx] = useState<{ gameVersion?: string; loader?: string }>({ gameVersion: profile?.context.gameVersion, loader: profile?.context.loader });
  const create = async () => {
    const p = await run(() => api.createProfile(gameId, name.trim() || t('Новый профиль'), ctx, copy ? profile?.id : undefined));
    if (p) {
      await run(() => api.switchProfile(gameId, p.id));
      onClose();
    }
  };
  return (
    <Modal
      title={t("Новый профиль")}
      sub={t("Отдельный набор модов со своей версией игры. Переключение профиля пересобирает папку игры.")}
      onClose={onClose}
      size="sm"
      foot={
        <>
          <span className="grow" />
          <button className="btn ghost" onClick={onClose}>
            {t('Отмена')}
          </button>
          <button className="btn primary" onClick={create}>
            {t('Создать и включить')}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label htmlFor="pname">{t('Название')}</label>
        <input id="pname" className="input" autoFocus value={name} placeholder={t("Например, «Выживание 1.21»")} onChange={(e) => setName(e.target.value)} />
        {def?.kind === 'minecraft' && <McContextFields version={ctx.gameVersion} loader={ctx.loader} onChange={setCtx} />}
        <span>{t('Скопировать моды')}</span>
        <div className="row">
          <Switch on={copy} onChange={setCopy} label={t("Скопировать моды текущего профиля")} />
          <span className="muted">{t('из «{0}»', profile?.name)}</span>
        </div>
      </div>
    </Modal>
  );
}
