import assert from 'node:assert/strict';
import { test } from 'node:test';

test('the Mac file panel shortcut matches a Command-Shift-E keypress', async () => {
  globalThis.window = { desktop: { platform: 'darwin' } };
  try {
    const { comboOf, keyFor } = await import('../src/shortcuts.ts');
    const prefs = { shortcuts: { keys: {} } };
    const event = { code: 'KeyE', shiftKey: true, metaKey: true };
    assert.equal(keyFor(prefs, 'toggleFiles'), comboOf(event));
  } finally {
    delete globalThis.window;
  }
});
