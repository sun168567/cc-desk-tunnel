import { createI18n, pseudoLanguage, resolveLanguage } from '@cc-desk-tunnel/i18n';
import { getPrefs, onPrefs } from './prefs.ts';

// The window's language: the one chosen in the settings, or the system's. The desktop's main process says which
// languages the system prefers (`boot` in main.cjs), so that the window and its tray and dialogs agree; a browser
// says it itself. `?lang=en-XA` in development shows the made-up language that finds text left out of the
// catalogs (packages/i18n).
const systemLanguages = () => window.desktop?.boot?.languages ?? navigator.languages;
const pseudo =
  import.meta.env.DEV && new URLSearchParams(location.search).get('lang') === pseudoLanguage;
const chosen = () =>
  pseudo ? pseudoLanguage : resolveLanguage(getPrefs().language, systemLanguages());

export const i18n = createI18n(chosen());
// Text outside what React draws, such as a notification or an error, in the language at the moment it is made.
// What a component draws takes its text from `useTranslation`, which draws it again when the language changes.
export const t = i18n.t;

function follow() {
  const language = chosen();
  if (i18n.language !== language) void i18n.changeLanguage(language);
  // The page's language picks the right glyphs for Chinese and tells assistive technology how to read it.
  document.documentElement.lang = language === pseudoLanguage ? 'en' : language;
}
follow();
onPrefs(follow);
