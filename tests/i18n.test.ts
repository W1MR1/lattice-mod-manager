import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { keyId, langFromLcid, langFromLocale, LANGS, plural, setLang, t } from '../shared/i18n';
// @ts-expect-error plain .mjs script without types
import { check, keyId as scriptKeyId } from '../scripts/i18n.mjs';

const root = path.resolve(__dirname, '..');

describe('i18n', () => {
  afterEach(() => setLang('ru'));

  it('every interface string is translated into every language, with its placeholders', () => {
    const { keys, report } = check(root) as { keys: Map<string, string[]>; report: Record<string, { missing: string[]; broken: string[] }> };
    expect(keys.size).toBeGreaterThan(500);
    for (const [lang, r] of Object.entries(report)) {
      expect({ lang, missing: r.missing }).toEqual({ lang, missing: [] });
      expect({ lang, broken: r.broken }).toEqual({ lang, broken: [] });
    }
    // the script and the app hash strings the same way
    for (const k of [...keys.keys()].slice(0, 50)) expect(scriptKeyId(k)).toBe(keyId(k));
  });

  it('translates, fills arguments and falls back to the source', () => {
    setLang('en');
    expect(t('Играть')).toBe('Play');
    expect(t('Удалить выбранные ({0})', 3)).toBe('Delete selected (3)');
    expect(t('Строка, которой нет в словарях')).toBe('Строка, которой нет в словарях');
    setLang('ru');
    expect(t('Удалить выбранные ({0})', 3)).toBe('Удалить выбранные (3)');
  });

  it('picks plural forms per language', () => {
    const mods = (n: number) => plural(n, 'мод', 'мода', 'модов');
    setLang('ru');
    expect([1, 3, 5, 21, 112].map(mods)).toEqual(['1 мод', '3 мода', '5 модов', '21 мод', '112 модов']);
    setLang('en');
    expect([1, 2].map(mods)).toEqual(['1 mod', '2 mods']);
    setLang('de');
    expect(mods(1)).toBe('1 Mod');
    setLang('zh-CN');
    expect(mods(7)).toBe('7 个模组');
    setLang('es');
    expect(mods(1000000)).toBe('1000000 mods');
  });

  it('maps the installer choice and the system locale to a language', () => {
    expect(LANGS.map((l) => l.id)).toEqual(['en', 'zh-CN', 'ru', 'es', 'pt-BR', 'de']);
    expect([1033, 2052, 1049, 1034, 3082, 1046, 1031].map(langFromLcid)).toEqual(['en', 'zh-CN', 'ru', 'es', 'es', 'pt-BR', 'de']);
    expect(langFromLcid(1036)).toBeUndefined();
    expect(['pt-PT', 'zh-Hans-CN', 'de-AT', 'ru', 'fr-FR', undefined].map(langFromLocale)).toEqual(['pt-BR', 'zh-CN', 'de', 'ru', 'en', 'en']);
  });
});
