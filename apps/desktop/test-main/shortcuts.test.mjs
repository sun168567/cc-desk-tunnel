import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

// Each action's default shortcut on a system, beside what a press of those keys is recorded as. A process of its own
// for each system: shortcuts.ts reads which one it is when it is loaded.
function defaultsOn(platform) {
  const module = new URL('../src/shortcuts.ts', import.meta.url).href;
  const script = `globalThis.window = { desktop: { platform: ${JSON.stringify(platform)} } };
const { actions, comboOf, keyFor } = await import(${JSON.stringify(module)});
const prefs = { shortcuts: { keys: {} } };
const pressed = (keys) => comboOf({
  code: keys.at(-1),
  ctrlKey: keys.includes('Ctrl'),
  altKey: keys.includes('Alt'),
  shiftKey: keys.includes('Shift'),
  metaKey: keys.includes('Win'),
});
console.log(JSON.stringify(actions.map(({ id }) => {
  const combo = keyFor(prefs, id);
  return [id, combo, pressed(combo.split('+'))];
})));`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

for (const platform of ['win32', 'darwin', 'linux'])
  test(`every default shortcut on ${platform} matches a press of its keys`, () => {
    for (const [action, combo, pressed] of defaultsOn(platform))
      assert.equal(combo, pressed, action);
  });

test('the file panel answers to Command-Shift-E on a Mac', () => {
  const [, combo] = defaultsOn('darwin').find(([action]) => action === 'toggleFiles');
  assert.equal(combo, 'Shift+Win+KeyE');
});
