import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileName, pieces } from '../src/attachments.ts';

test('quoted paths of the project computer are files, where they stand', () => {
  assert.deepEqual(pieces('看 "C:\\a b\\shot.png" 和"D:\\x.txt"。', true), [
    { text: '看 ' },
    { path: 'C:\\a b\\shot.png' },
    { text: ' 和' },
    { path: 'D:\\x.txt' },
    { text: '。' },
  ]);
  assert.deepEqual(pieces('"C:\\only.md"', true), [{ path: 'C:\\only.md' }]);
  assert.deepEqual(pieces('"/Users/me/a.png" ok', false), [
    { path: '/Users/me/a.png' },
    { text: ' ok' },
  ]);
});

test('other quotes stay words', () => {
  const words = (text, windows) => assert.deepEqual(pieces(text, windows), text ? [{ text }] : []);
  words('say "hello" and "/compact"', false);
  words('a POSIX "/Users/me/a.png" in a Windows session', true);
  words('"C:\\a.png" in a session on a Mac', false);
  words('"C:\\broken\nline"', true);
  words('', true);
});

test('a file goes by its name', () => {
  assert.equal(fileName('C:\\Users\\me\\Pictures\\a.png'), 'a.png');
  assert.equal(fileName('/home/me/notes/'), 'notes');
});
