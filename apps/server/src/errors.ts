import {
  createI18n,
  sourceLanguage,
  wordsText,
  type Phrase,
  type Words,
} from '@cc-desk-tunnel/i18n';

// The service says its words as phrases, which each client puts in its own language. Where a text is wanted as
// well — the frames another version reads, a log, a client from before phrases — it is said in the source
// language, from the same catalogs.
const source = createI18n(sourceLanguage);
export const textOf = (words: Words) => wordsText(source.t, words);
// A text and the phrase it says, for a frame that carries both.
export const said = (words: Words) =>
  typeof words === 'string' ? { message: words } : { message: textOf(words), phrase: words };

// What an error says: the phrase of one that carries it, else its message (outside text, as it is).
export const wordsOf = (error: unknown): Words =>
  (error as { phrase?: Phrase } | null)?.phrase ??
  (error instanceof Error ? error.message : String(error));

// A failure the client can act on; `code` travels in the response frame for the client to act on, the words
// for the user to read.
export class DomainError extends Error {
  code: string;
  phrase?: Phrase;
  constructor(code: string, words: Words) {
    super(textOf(words));
    this.code = code;
    if (typeof words !== 'string') this.phrase = words;
  }
}
