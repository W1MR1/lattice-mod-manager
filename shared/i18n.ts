// Interface languages. The Russian text in the code is the source: t('Удалить')
// looks the string up by a short hash in the dictionary of the current language,
// falls back to English, then to the source itself. {0}, {1}… are arguments.
// `npm run i18n` lists strings that have no translation yet.
import de from './locales/de';
import en from './locales/en';
import es from './locales/es';
import ptBR from './locales/pt-BR';
import zhCN from './locales/zh-CN';

export type Lang = 'en' | 'zh-CN' | 'ru' | 'es' | 'pt-BR' | 'de';

/** The six most used languages of PC players (Steam survey order), with their own names. */
export const LANGS: { id: Lang; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'zh-CN', name: '简体中文' },
  { id: 'ru', name: 'Русский' },
  { id: 'es', name: 'Español' },
  { id: 'pt-BR', name: 'Português (Brasil)' },
  { id: 'de', name: 'Deutsch' },
];

export type Dict = Record<string, string>;

const DICTS: Record<Lang, Dict | null> = { ru: null, en, 'zh-CN': zhCN, es, 'pt-BR': ptBR, de };

let current: Lang = 'ru';

export function setLang(l: Lang) {
  if (l in DICTS) current = l;
}

export function getLang(): Lang {
  return current;
}

const ids = new Map<string, string>();

/** Stable short id of a source string (FNV-1a, base 36). */
export function keyId(src: string): string {
  let id = ids.get(src);
  if (id) return id;
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  id = `k${h.toString(36)}`;
  ids.set(src, id);
  return id;
}

function lookup(src: string, lang = current): string {
  const d = DICTS[lang];
  if (!d) return src;
  const id = keyId(src);
  return d[id] ?? DICTS.en?.[id] ?? src;
}

export function t(src: string, ...args: unknown[]): string {
  const out = lookup(src);
  return args.length ? out.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m)) : out;
}

/** Marks a source string for translation where it is defined; translate it with t() where it is shown. */
export const tk = (src: string) => src;

const PLURAL_INDEX: Record<string, Partial<Record<Intl.LDMLPluralRule, number>>> = {
  // Russian forms: one (1, 21), few (2–4), many (5–20)
  ru: { one: 0, few: 1, many: 2, other: 1 },
  en: { one: 0, other: 1 },
  de: { one: 0, other: 1 },
  es: { one: 0, many: 1, other: 1 },
  'pt-BR': { one: 0, many: 1, other: 1 },
  'zh-CN': { other: 0 },
};

const rules = new Map<Lang, Intl.PluralRules>();

/**
 * "5 модов" in the current language. The Russian forms are the key; other
 * languages store theirs as "mod|mods" (English order: one|other).
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const forms = (current === 'ru' ? `${one}|${few}|${many}` : lookup(`${one}|${few}|${many}`)).split('|');
  let r = rules.get(current);
  if (!r) rules.set(current, (r = new Intl.PluralRules(current)));
  const idx = PLURAL_INDEX[current]?.[r.select(n)] ?? forms.length - 1;
  const word = forms[Math.min(idx, forms.length - 1)];
  return `${n} ${word}`;
}

/** Interface language for a system locale such as "pt-BR", "zh-Hans-CN" or "de-AT". */
export function langFromLocale(locale: string | undefined): Lang {
  const l = (locale ?? '').toLowerCase();
  if (l.startsWith('zh')) return 'zh-CN';
  if (l.startsWith('pt')) return 'pt-BR';
  for (const x of ['ru', 'es', 'de', 'en'] as const) if (l.startsWith(x)) return x;
  return 'en';
}

/** Windows language ids the installer can pass on (NSIS $LANGUAGE). */
export function langFromLcid(lcid: number): Lang | undefined {
  const map: Record<number, Lang> = { 1033: 'en', 2052: 'zh-CN', 1049: 'ru', 1034: 'es', 3082: 'es', 1046: 'pt-BR', 1031: 'de' };
  return map[lcid];
}

/** BCP 47 tag for dates and numbers. */
export function locale(): string {
  return current === 'ru' ? 'ru-RU' : current;
}
