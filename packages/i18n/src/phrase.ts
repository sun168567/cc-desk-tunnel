import type { TFunction } from 'i18next';
import type { Messages } from './resources.d.ts';

// Words for a person as a message of the catalogs and what it is filled in with: the service sends them so,
// and each client says them in its own language. The same shape as `Phrase` in packages/protocol.
export type Phrase = { key: string; params?: Record<string, PhraseValue> };
export type PhraseValue = string | number | Phrase | (string | Phrase)[];
// A value a message is filled in with, and a list of them for a message that formats it as a list.
export type Value = string | number | Phrase;
export type ListValue = (string | Phrase)[];
// Words of the service as a record holds them: a phrase, or the text a version before phrases wrote.
export type Words = string | Phrase;
export type MessageKey = keyof Messages;

// A phrase of a message, `namespace:key`, with the values its catalog entry is filled in with: TypeScript
// checks both against the zh-CN catalog.
export function phrase<K extends MessageKey>(
  key: K,
  ...[params]: Record<string, never> extends Messages[K]
    ? [params?: Messages[K]]
    : [params: Messages[K]]
): Phrase {
  return params && Object.keys(params).length
    ? { key, params: params as Record<string, PhraseValue> }
    : { key };
}

type Translate = (key: string, options?: Record<string, unknown>) => string;
// The text of words in the language of `t`: a phrase's values that are words of their own are said first. Text of
// a version before phrases is shown as it is, and so is a phrase of a message this version does not have, by
// `fallback` (the text the service sent with it) or its key.
export function wordsText(t: TFunction, words: Words, fallback?: string): string {
  if (typeof words === 'string') return words;
  const params: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(words.params ?? {}))
    params[name] = Array.isArray(value)
      ? value.map((item) => wordsText(t, item))
      : typeof value === 'object'
        ? wordsText(t, value)
        : value;
  return (t as unknown as Translate)(words.key, {
    ...params,
    ...(fallback !== undefined && { defaultValue: fallback }),
  });
}
