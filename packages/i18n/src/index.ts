import { createInstance } from 'i18next';
import type { i18n as I18n } from 'i18next';
import { catalogs, namespaces } from './catalogs.ts';

export { namespaces };
export { phrase, wordsText } from './phrase.ts';
export type { ListValue, MessageKey, Phrase, PhraseValue, Value, Words } from './phrase.ts';
export type { I18n };
// The `t` of an instance (createI18n): what code shared by the clients takes to say its words.
export type T = I18n['t'];
export type Namespace = (typeof namespaces)[number];

// The languages the program speaks. zh-CN is the source: a message is written there first, and every other
// language holds the same keys with the same values to fill in (test/catalogs.test.ts checks both).
export const languages = ['zh-CN', 'en'] as const;
export type Language = (typeof languages)[number];
export const sourceLanguage: Language = 'zh-CN';
// What the settings hold: the system's language, or one of the program's.
export type LanguageChoice = 'system' | Language;
export const languageChoices: readonly LanguageChoice[] = ['system', ...languages];
// Each language by its own name, as a list of languages shows them whatever language it is in.
export const languageNames: Record<Language, string> = { 'zh-CN': '简体中文', en: 'English' };
export const isLanguageChoice = (value: unknown): value is LanguageChoice =>
  languageChoices.includes(value as LanguageChoice);

// The program's language for a choice and the system's preferred languages, most preferred first (BCP 47 tags,
// as `navigator.languages`, Electron's `app.getPreferredSystemLanguages()` or LANG give them). Chinese of any
// region reads zh-CN until it has a catalog of its own; a system that prefers none of the program's languages
// gets English.
export function resolveLanguage(
  choice: LanguageChoice | undefined,
  preferred: readonly string[],
): Language {
  if (choice && choice !== 'system') return choice;
  for (const tag of preferred) {
    const primary = tag.toLowerCase().replace('_', '-').split(/[-.@]/)[0];
    if (primary === 'zh') return 'zh-CN';
    if (primary === 'en') return 'en';
  }
  return 'en';
}

// A made-up language for development: the English text with its letters accented and a third longer, between
// brackets. Text that does not change with it was never taken from a catalog, and a layout that holds it holds
// the longer words of other languages too. Placeholders and markup are left as they are.
export const pseudoLanguage = 'en-XA';
const accents: Record<string, string> = Object.fromEntries(
  [...'aeiouycnAEIOUYCN'].map((letter, index) => [letter, 'åéîöüýçñÅÉÎÖÜÝÇÑ'[index]]),
);
export function pseudo(text: string) {
  const parts = text.split(/(\{\{[^}]+\}\}|<[^>]+>|\$t\([^)]+\))/);
  const body = parts
    .map((part, index) => (index % 2 ? part : part.replace(/[A-Za-z]/g, (c) => accents[c] ?? c)))
    .join('');
  return `[${body}${'~'.repeat(Math.ceil(text.length / 3))}]`;
}
type Tree = { [key: string]: string | Tree };
const mapTree = (tree: Tree, change: (text: string) => string): Tree =>
  Object.fromEntries(
    Object.entries(tree).map(([key, value]) => [
      key,
      typeof value === 'string' ? change(value) : mapTree(value, change),
    ]),
  );

// The made-up language formats dates and numbers as English does: `common:locale` is a tag, not text.
const pseudoCatalogs = mapTree(catalogs.en as unknown as Tree, pseudo);
(pseudoCatalogs.common as Tree).locale = catalogs.en.common.locale;
export const resources = { ...catalogs, [pseudoLanguage]: pseudoCatalogs };

// How each language writes lists in a sentence, for the formats of `{{value, format}}`: `quoted` names,
// `clauses` that begin a sentence, `parts` of a longer list, a `series` of like things, and the `commas` between
// short accounts of what was done. The made-up language writes as English.
const formats = ['quoted', 'clauses', 'parts', 'series', 'commas'] as const;
type Marks = Record<(typeof formats)[number], (items: string[]) => string>;
const marks: Record<Language, Marks> = {
  'zh-CN': {
    quoted: (items) => items.map((item) => `「${item}」`).join(''),
    clauses: (items) => items.join('，'),
    parts: (items) => items.join('；'),
    series: (items) => items.join('、'),
    commas: (items) => items.join('，'),
  },
  en: {
    quoted: (items) =>
      new Intl.ListFormat('en', { type: 'conjunction' }).format(items.map((item) => `“${item}”`)),
    clauses: (items) => {
      const text = items.join('; ');
      return text.charAt(0).toUpperCase() + text.slice(1);
    },
    parts: (items) => new Intl.ListFormat('en', { type: 'conjunction' }).format(items),
    series: (items) => new Intl.ListFormat('en', { type: 'conjunction' }).format(items),
    commas: (items) => items.join(', '),
  },
};
const marksOf = (language: string | undefined) =>
  marks[languages.find((item) => item === language) ?? 'en'];
const items = (value: unknown) => (Array.isArray(value) ? value.map(String) : [String(value)]);

// An instance of i18next in one language, ready at once: the catalogs are part of the program, nothing is
// fetched. A missing message shows as its key rather than as another language's text, so that it is seen; the
// tests keep every language complete.
export function createI18n(language: Language | typeof pseudoLanguage): I18n {
  const instance = createInstance();
  void instance.init({
    lng: language,
    fallbackLng: false,
    supportedLngs: [...languages, pseudoLanguage],
    resources: resources as never,
    ns: [...namespaces],
    defaultNS: 'common',
    initAsync: false,
    returnNull: false,
    // What a message is filled in with is shown as text by whoever shows it: React, a terminal, a notification.
    interpolation: { escapeValue: false },
  });
  for (const format of formats)
    instance.services.formatter?.add(format, (value, language) =>
      marksOf(language)[format](items(value)),
    );
  return instance;
}
