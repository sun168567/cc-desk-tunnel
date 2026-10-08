import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNativeSettings, updateNativeSettings } from '../src/native-settings.ts';

test('native settings edit only the listed keys of the CLI user settings file', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'proxy-settings-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'nested', 'settings.json');
  assert.equal(
    readNativeSettings(path).autoCompactWindow,
    null,
    'A missing file reads as all defaults',
  );
  updateNativeSettings({ fastMode: true }, path);
  writeFileSync(
    path,
    JSON.stringify({ env: { KEEP: '1' }, hooks: {}, fastMode: true, autoCompactWindow: 'big' }),
  );
  assert.deepEqual(
    (({ fastMode, autoCompactWindow }) => ({ fastMode, autoCompactWindow }))(
      readNativeSettings(path),
    ),
    { fastMode: true, autoCompactWindow: null },
    'A hand-written value outside the accepted range shows as unset',
  );
  const saved = updateNativeSettings(
    { fastMode: null, autoCompactWindow: 500_000, language: 'chinese' },
    path,
  );
  assert.equal(saved.autoCompactWindow, 500_000);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    env: { KEEP: '1' },
    hooks: {},
    autoCompactWindow: 500_000,
    language: 'chinese',
  });
  // The CLI's own richer forms of a value are left as they are and shown as unset.
  writeFileSync(path, JSON.stringify({ attribution: { commit: '自定义' }, fallbackModel: [] }));
  assert.equal(readNativeSettings(path).attribution, null);
  assert.equal(readNativeSettings(path).fallbackModel, null);
  updateNativeSettings({ fallbackModel: ['sonnet'], bashOutputMaxChars: 60_000 }, path);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    attribution: { commit: '自定义' },
    fallbackModel: ['sonnet'],
    bashOutputMaxChars: 60_000,
  });
  writeFileSync(path, '{ broken');
  assert.throws(() => updateNativeSettings({ fastMode: true }, path));
  assert.equal(readFileSync(path, 'utf8'), '{ broken', 'An unreadable file is never overwritten');
});
