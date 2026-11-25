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
// Words in the current language: a phrase (failure.cjs) is said, text is as it is.
export const say = (words) => wordsText(i18n.t, words);
// What a failure says: its phrase, or the message of one that has none.
export const failureText = (error) =>
  error?.phrase ? say(error.phrase) : String(error?.message ?? error);
