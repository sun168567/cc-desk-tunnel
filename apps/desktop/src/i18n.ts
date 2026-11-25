import { createI18n, namespaces, sourceLanguage, wordsText } from '@cc-desk-tunnel/i18n';
import type { Words } from '@cc-desk-tunnel/i18n';
import { setI18n, useTranslation } from 'react-i18next';

// The window's text, from the catalogs of packages/i18n. It starts in the source language; language.ts, which the
// window loads first, puts it in the language the settings or the system choose and follows them. Code that runs
// without a window, as the unit tests run it, reads Chinese.
export const i18n = createI18n(sourceLanguage);
// The one instance of the window, which every component's useTranslation and <Trans> use: no provider is needed
// around what is drawn, whether by main.tsx or a test that mounts a component alone.
setI18n(i18n);
// Text outside what React draws, such as a notification or an error, in the language at the moment it is made.
// What a component draws takes its text from `useTranslation`, which draws it again when the language changes.
export const t = i18n.t;
// A component's `t`, for keys of every namespace (`connection:login.title`); it draws the component again when the
// language changes.
export const useT = (): T => useTranslation(namespaces).t;
// The `t` a function takes when it makes text at render time: a component's, from useT(), or the one above.
export type T = typeof t;
// The language's tag for formatting dates and numbers (`toLocaleString`), from the same `t`: what a component
// formats follows the language as its text does.
export const localeOf = (t: T) => t('common:locale');

// What the service said, in the window's language at the moment it is said (see `Say` in client.ts).
export const say = (words: Words, fallback?: string) => wordsText(t, words, fallback);
