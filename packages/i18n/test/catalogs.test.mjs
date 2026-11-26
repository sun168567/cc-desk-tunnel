import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { catalogs, namespaces } from '../src/catalogs.ts';
import {
  createI18n,
  languages,
  pseudo,
  pseudoLanguage,
  resolveLanguage,
  sourceLanguage,
} from '../src/index.ts';
import { resourceTypes, typesFile } from '../../../scripts/i18n-types.mjs';

const flat = (tree, prefix = '') =>
  Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [[prefix + key, value]] : flat(value, `${prefix}${key}.`),
  );
const form = /_(zero|one|two|few|many|other)$/;
// A message's keys by the key without its plural form, each with its forms and the values it is filled in with.
function messages(language, namespace) {
  const grouped = new Map();
  for (const [key, text] of flat(catalogs[language][namespace])) {
    const base = key.replace(form, '');
    const entry = grouped.get(base) ?? { forms: new Set(), values: new Set() };
    entry.forms.add(form.exec(key)?.[1] ?? '');
    for (const [, name] of text.matchAll(/\{\{\s*([^,}\s]+)/g)) entry.values.add(name);
    grouped.set(base, entry);
  }
  return grouped;
}

test('every catalog file is listed, in every language', () => {
  for (const language of languages) {
    const folder = new URL(`../src/locales/${language}/`, import.meta.url);
    const files = readdirSync(folder).filter((file) => file.endsWith('.json'));
    assert.deepEqual(files.sort(), namespaces.map((name) => `${name}.json`).sort(), language);
  }
});

for (const language of languages.filter((item) => item !== sourceLanguage))
  test(`${language} has every message of ${sourceLanguage}, in its plural forms, with the same values`, () => {
    const categories = new Set(new Intl.PluralRules(language).resolvedOptions().pluralCategories);
    for (const namespace of namespaces) {
      const source = messages(sourceLanguage, namespace);
      const target = messages(language, namespace);
      assert.deepEqual([...target.keys()].sort(), [...source.keys()].sort(), `${namespace} keys`);
      for (const [key, { forms, values }] of target) {
        const where = `${namespace}:${key}`;
        const plural = source.get(key).forms.has('other');
        if (plural) assert.deepEqual(forms, categories, `${where} plural forms`);
        else assert.deepEqual(forms, new Set(['']), `${where} is not plural`);
        const expected = new Set(source.get(key).values);
        if (plural) expected.add('count');
        const actual = new Set(values);
        if (plural) actual.add('count');
        assert.deepEqual(actual, expected, `${where} values`);
      }
    }
  });

test(`${sourceLanguage} writes plurals only in its one form`, () => {
  const categories = new Set(
    new Intl.PluralRules(sourceLanguage).resolvedOptions().pluralCategories,
  );
  for (const namespace of namespaces)
    for (const [key, { forms }] of messages(sourceLanguage, namespace))
      for (const item of forms)
        assert.ok(item === '' || categories.has(item), `${namespace}:${key}_${item}`);
});

test('no language but Chinese holds Chinese text', () => {
  for (const language of languages.filter((item) => !item.startsWith('zh')))
    for (const namespace of namespaces)
      for (const [key, text] of flat(catalogs[language][namespace]))
        // Where a link goes is an address, not text: the docs' headings are Chinese.
        assert.doesNotMatch(
          text.replace(/\]\([^)]+\)/g, ']'),
          /[㐀-鿿]/,
          `${language} ${namespace}:${key}`,
        );
});

test('the catalogs’ types are up to date', async () => {
  assert.equal(
    readFileSync(typesFile, 'utf8'),
    await resourceTypes(),
    'Run node scripts/i18n-types.mjs',
  );
});

test('the language follows the choice, else the first of the system’s it speaks', () => {
  assert.equal(resolveLanguage('en', ['zh-CN']), 'en');
  assert.equal(resolveLanguage('system', ['zh-TW', 'en-US']), 'zh-CN');
  assert.equal(resolveLanguage('system', ['fr-FR', 'en-GB', 'zh-CN']), 'en');
  assert.equal(resolveLanguage('system', ['de-DE']), 'en');
  assert.equal(resolveLanguage(undefined, ['zh_CN.UTF-8']), 'zh-CN');
  assert.equal(resolveLanguage('system', []), 'en');
});

test('the made-up language keeps placeholders and markup, and shows a missing message by its key', () => {
  assert.equal(pseudo('Open {{name}} <0>now</0>'), '[Öpéñ {{name}} <0>ñöw</0>~~~~~~~~]');
  // The help's marks: where a link goes, a shortcut's action, a name it fills in.
  assert.equal(
    pseudo('See [modes](#approval), [[cycleMode]], {device}'),
    '[Séé [mödés](#approval), [[cycleMode]], {device}~~~~~~~~~~~~~~~~]',
  );
  const i18n = createI18n(pseudoLanguage);
  assert.match(i18n.t('language.system'), /^\[Üsé sýstém séttîñg~+\]$/);
  assert.equal(createI18n('en').t('language.nothing'), 'language.nothing');
});
