// Lists the interface strings and checks the translations.
//   npm run i18n               missing and unused keys per language
//   npm run i18n -- --sources  every key as "id<TAB>source" (for translating)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const LOCALES = ['en', 'zh-CN', 'es', 'pt-BR', 'de'];

/** Same as keyId() in shared/i18n.ts. */
export function keyId(src) {
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `k${h.toString(36)}`;
}

function files(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/shared[\\/]locales/.test(p)) out.push(p);
    }
  };
  for (const d of ['src', 'electron', 'shared']) walk(path.join(root, d));
  return out;
}

const literal = (n) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined);

/** Source strings used with t(), tk() and plural(): Map<source, where[]>. */
export function collectKeys(root) {
  const keys = new Map();
  const add = (src, where) => {
    if (!keys.has(src)) keys.set(src, []);
    keys.get(src).push(where);
  };
  for (const file of files(root)) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/\b(t|tk|plural)\(/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const name = n.expression.text;
        const where = `${path.relative(root, file).replace(/\\/g, '/')}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
        if ((name === 't' || name === 'tk') && literal(n.arguments[0]) !== undefined) add(literal(n.arguments[0]), where);
        if (name === 'plural' && n.arguments.length === 4) {
          const forms = n.arguments.slice(1).map(literal);
          if (forms.every((f) => f !== undefined)) add(forms.join('|'), where);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return keys;
}

/** A locale file as { id: text }. */
export function readLocale(root, lang) {
  const file = path.join(root, 'shared', 'locales', `${lang}.ts`);
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out = {};
  const visit = (n) => {
    if (ts.isPropertyAssignment(n)) {
      const k = ts.isIdentifier(n.name) ? n.name.text : literal(n.name);
      const v = literal(n.initializer);
      if (k !== undefined && v !== undefined) out[k] = v;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const placeholders = (s) => (s.match(/\{\d+\}/g) ?? []).sort().join();

/** Problems per language: missing ids, unused ids, broken {n} placeholders, wrong plural forms. */
export function check(root) {
  const keys = collectKeys(root);
  const byId = new Map([...keys.keys()].map((k) => [keyId(k), k]));
  const report = {};
  for (const lang of LOCALES) {
    const d = readLocale(root, lang);
    const missing = [...byId].filter(([id]) => !(id in d)).map(([id, src]) => `${id}\t${src}`);
    const unused = Object.keys(d).filter((id) => !byId.has(id));
    const broken = [...byId]
      .filter(([id, src]) => id in d && (placeholders(src) !== placeholders(d[id]) || (src.split('|').length === 3 && !/^[^|]+(\|[^|]+)?$/.test(d[id]))))
      .map(([id, src]) => `${id}\t${src}\t→ ${d[id]}`);
    report[lang] = { missing, unused, broken };
  }
  return { keys, report };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const keys = collectKeys(root);
  if (process.argv.includes('--sources')) {
    for (const k of keys.keys()) console.log(`${keyId(k)}\t${k.replace(/\n/g, '\\n')}`);
  } else {
    const { report } = check(root);
    console.log(`${keys.size} strings`);
    let bad = 0;
    for (const [lang, r] of Object.entries(report)) {
      console.log(`${lang}: missing ${r.missing.length}, unused ${r.unused.length}, broken ${r.broken.length}`);
      for (const l of [...r.missing, ...r.broken]) console.log(`  ${l}`);
      bad += r.missing.length + r.broken.length;
    }
    process.exitCode = bad ? 1 : 0;
  }
}
