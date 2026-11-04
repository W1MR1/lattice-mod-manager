export function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 Б';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

export function speed(n: number): string {
  return `${bytes(n)}/с`;
}

export function count(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} млн`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)} тыс.`;
  return String(n);
}

export function ago(iso?: string): string {
  if (!iso) return '—';
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(d)) return '—';
  if (d < 60) return 'только что';
  if (d < 3600) return `${Math.floor(d / 60)} мин назад`;
  if (d < 86400) return `${Math.floor(d / 3600)} ч назад`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} дн назад`;
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${w}`;
}

export function eta(remaining: number, bps: number): string {
  if (bps <= 0 || remaining <= 0) return '—';
  const s = remaining / bps;
  if (s < 60) return `${Math.ceil(s)} с`;
  if (s < 3600) return `${Math.floor(s / 60)} мин ${Math.ceil(s % 60)} с`;
  return `${Math.floor(s / 3600)} ч ${Math.floor((s % 3600) / 60)} мин`;
}

export const SOURCE_LABEL: Record<string, string> = {
  modrinth: 'Modrinth',
  thunderstore: 'Thunderstore',
  github: 'GitHub',
  nexus: 'Nexus Mods',
  local: 'Локальный',
};

export const LOADER_LABEL: Record<string, string> = {
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
};
