// Writes the help as Markdown for Claude on the server (see apps/desktop/src/help-markdown.ts): a folder for each
// language, each with an index. `node scripts/help-markdown.mjs [folder]`, apps/server/help by default; the Docker
// image and the server bundle are built with it, and scripts/dev.mjs runs it.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createI18n, languages } from '@cc-desk-tunnel/i18n';
import { helpMarkdown } from '../apps/desktop/src/help-markdown.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
export function writeHelp(folder = join(root, 'apps/server/help')) {
  rmSync(folder, { recursive: true, force: true });
  for (const language of languages) {
    const directory = join(folder, language);
    mkdirSync(directory, { recursive: true });
    for (const { name, text } of helpMarkdown(createI18n(language).t))
      writeFileSync(join(directory, name), text);
  }
  return folder;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(`Help for Claude: ${writeHelp(process.argv[2] && resolve(process.argv[2]))}`);
