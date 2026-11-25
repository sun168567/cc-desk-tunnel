import { createI18n, sourceLanguage, wordsText } from '@cc-desk-tunnel/i18n';

// ccdt's text, from the catalogs the desktop uses (packages/i18n).
const i18n = createI18n(sourceLanguage);
export const t = i18n.t;
// What the service said, as text: a phrase in ccdt's language, or the text of a version before phrases.
export const wordsOf = (words, fallback) => wordsText(i18n.t, words, fallback);
