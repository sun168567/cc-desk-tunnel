import { createI18n, resolveLanguage, sourceLanguage, wordsText } from '@cc-desk-tunnel/i18n';

// The words of the program outside its page: menus, dialogs, the tray and what a failure of the main process or
// the connection bridge says. They are in the window's language (src/language.ts), the one chosen in the shared
// settings or else the system's, so that a window and what surrounds it agree.
const i18n = createI18n(sourceLanguage);
export const t = i18n.t;
// Changes to the language `choice` resolves to among the system's; true when that is a change.
export function followLanguage(choice, systemLanguages) {
  const language = resolveLanguage(choice, systemLanguages);
  if (i18n.language === language) return false;
  void i18n.changeLanguage(language);
  return true;
}
// A failure that says what went wrong as a message of the catalogs (`phrase`), which is put into words where it
// is shown. Its `message` is the key, for a log.
export const failure = (key, params) =>
  Object.assign(new Error(key), { phrase: params ? { key, params } : { key } });
// What a failure says: its phrase in the current language, or the message of one that has none.
export const failureText = (error) =>
  error?.phrase ? wordsText(i18n.t, error.phrase) : String(error?.message ?? error);
