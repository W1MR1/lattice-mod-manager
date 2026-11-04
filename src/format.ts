import { locale, t } from '../shared/i18n';

export { plural } from '../shared/i18n';

export function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return t('0 Б');
  const u = [t('Б'), t('КБ'), t('МБ'), t('ГБ'), t('ТБ')];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

export function speed(n: number): string {
  return t('{0}/с', bytes(n));
}

export function count(n: number): string {
  if (n >= 1e6) return t('{0} млн', (n / 1e6).toFixed(1));
  if (n >= 1e3) return t('{0} тыс.', (n / 1e3).toFixed(n >= 1e4 ? 0 : 1));
  return String(n);
}

export function ago(iso?: string): string {
  if (!iso) return '—';
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(d)) return '—';
  if (d < 60) return t('только что');
  if (d < 3600) return t('{0} мин назад', Math.floor(d / 60));
  if (d < 86400) return t('{0} ч назад', Math.floor(d / 3600));
  if (d < 86400 * 30) return t('{0} дн назад', Math.floor(d / 86400));
  return new Date(iso).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });
}

export function eta(remaining: number, bps: number): string {
  if (bps <= 0 || remaining <= 0) return '—';
  const s = remaining / bps;
  if (s < 60) return t('{0} с', Math.ceil(s));
  if (s < 3600) return t('{0} мин {1} с', Math.floor(s / 60), Math.ceil(s % 60));
  return t('{0} ч {1} мин', Math.floor(s / 3600), Math.floor((s % 3600) / 60));
}

export const SOURCE_LABEL: Record<string, string> = {
  modrinth: 'Modrinth',
  thunderstore: 'Thunderstore',
  github: 'GitHub',
  nexus: 'Nexus Mods',
  get local() {
    return t('Локальный');
  },
};

export const LOADER_LABEL: Record<string, string> = {
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
};
