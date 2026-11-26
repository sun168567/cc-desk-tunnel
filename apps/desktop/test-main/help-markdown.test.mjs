import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { languages } from '@cc-desk-tunnel/i18n';
import { helpShapes } from '../src/help-content.ts';
import { writeHelp } from '../../../scripts/help-markdown.mjs';

// The help as Claude reads it on the server: what the window would do is said in words, and every link leads to a
// file and a heading that are there.
test('the help for Claude has every article in each language, and its links lead to what is there', (t) => {
  const folder = writeHelp(mkdtempSync(join(tmpdir(), 'ccdt-help-')));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const names = ['index.md', ...helpShapes.map(({ id }) => `${id}.md`)].sort();
  for (const language of languages) {
    const directory = join(folder, language);
    assert.deepEqual(readdirSync(directory).sort(), names, language);
    const index = readFileSync(join(directory, 'index.md'), 'utf8');
    for (const { id } of helpShapes) assert.match(index, new RegExp(`\\]\\(${id}\\.md\\)`), id);
    for (const name of names) {
      const text = readFileSync(join(directory, name), 'utf8');
      // Nothing is left that only the window understands.
      assert.doesNotMatch(text, /\{device\}|\{here\}|\[\[\w+\]\]|\]\((#|settings:|do:)/, name);
      for (const [, file, anchor] of text.matchAll(/\]\(([\w-]+\.md)(?:#([\w-]+))?\)/g)) {
        assert.ok(existsSync(join(directory, file)), `${language}/${name} → ${file}`);
        if (anchor)
          assert.ok(
            readFileSync(join(directory, file), 'utf8').includes(`<a id="${anchor}"></a>`),
            `${language}/${name} → ${file}#${anchor}`,
          );
      }
    }
  }
});
