import { failureText, followLanguage, say, t } from '../../desktop/electron/words.mjs';

// ccdt's words come from the catalogs the desktop uses (packages/i18n), through the instance of the connection
// bridge it shares, so that what the bridge says is in the same language. That is the system's: the locale a
// terminal sets (LC_ALL, LC_MESSAGES, LANG), else the one Node reads from the system.
export const systemLanguages = (env = process.env) =>
  [env.LC_ALL, env.LC_MESSAGES, env.LANG, Intl.DateTimeFormat().resolvedOptions().locale].filter(
    (tag) => tag && !/^(C|POSIX)(\.|$)/i.test(tag),
  );
followLanguage('system', systemLanguages());
// The language ccdt's settings choose: one of the program's, else (none chosen) the system's.
export const useLanguage = (choice) => followLanguage(choice ?? 'system', systemLanguages());
// What a failure says, a phrase of the bridge's said in ccdt's language.
export { failureText, followLanguage, t };
// What the service said, as text: a phrase in ccdt's language, or the text of a version before phrases.
export const wordsOf = (words, fallback) => say(words, fallback);
