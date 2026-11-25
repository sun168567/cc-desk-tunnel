import assert from 'node:assert/strict';
import { test } from 'node:test';
import { counts, literals, readList } from '../../../scripts/i18n-literals.mjs';

// See scripts/i18n-literals.mjs: Chinese written in the code is only what files not yet moved to the catalogs
// still hold, and that only goes down.
test('the code holds no Chinese text beyond what is still to be moved to the catalogs', () => {
  const { pending, kept } = readList();
  const now = counts();
  const problems = [];
  for (const [file, count] of Object.entries(now)) {
    const allowed = pending[file] ?? kept[file]?.count ?? 0;
    if (count > allowed) {
      const shown = literals(file)
        .slice(0, 5)
        .map(({ line, text }) => `  ${file}:${line} ${text}`);
      problems.push(
        `${file} holds ${count} pieces of Chinese text, ${allowed} allowed:\n${shown.join('\n')}`,
      );
    } else if (count < allowed)
      problems.push(
        `${file} holds ${count} now: lower its allowance in packages/i18n/literals.json.`,
      );
  }
  for (const file of Object.keys({ ...pending, ...kept }))
    if (!now[file])
      problems.push(`${file} holds none now: take it out of packages/i18n/literals.json.`);
  for (const [file, { reason }] of Object.entries(kept))
    if (!reason) problems.push(`${file} is kept without a reason.`);
  assert.deepEqual(problems, []);
});
