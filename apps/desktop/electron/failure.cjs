// Words as a message of the catalogs (packages/i18n) with the values it is filled in with, the shape of
// `Phrase` there. The main process says them in the language of the moment where they are shown (words.mjs).
// Plain CommonJS that loads nothing, so that every part of the main process can use it: the CommonJS modules, the
// ones that ship as written beside the bundle, and the processes they start.
const phrase = (key, params) => (params ? { key, params } : { key });
// A failure that says what went wrong in `phrase`; its `message` is the key, for a log. `more` are further
// properties, such as `fatal`.
const failure = (key, params, more) =>
  Object.assign(new Error(key), { phrase: phrase(key, params) }, more);
// A failure that says `words`, a phrase.
const failureOf = (words, more) => failure(words.key, words.params, more);
module.exports = { failure, failureOf, phrase };
