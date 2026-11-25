import { z } from 'zod';

// Words for a person: a key of the catalogs (packages/i18n) and the values it is filled in with, which each
// client says in its own language. A value may be words of their own, said first; outside text (a command's
// output, a title) goes as a value, as it is.
export type Phrase = { key: string; params?: Record<string, PhraseValue> };
export type PhraseValue = string | number | Phrase | (string | Phrase)[];
const phraseValueSchema: z.ZodType<PhraseValue> = z.lazy(() =>
  z.union([z.string(), z.number(), phraseSchema, z.array(z.union([z.string(), phraseSchema]))]),
);
export const phraseSchema: z.ZodType<Phrase> = z.lazy(() =>
  z.object({
    key: z.string().min(1).max(200),
    params: z.record(z.string(), phraseValueSchema).optional(),
  }),
);
// What the service said, in a record that outlives versions: a phrase, or the text a version before phrases
// wrote, shown as it was.
export const wordsSchema = z.union([z.string(), phraseSchema]);
export type Words = z.infer<typeof wordsSchema>;
