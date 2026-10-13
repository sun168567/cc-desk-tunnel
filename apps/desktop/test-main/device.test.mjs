import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isHere } from '../src/device.ts';

const session = (device, projectPath = 'D:\\Work\\Project') => ({ device, projectPath });
const pc = { id: 'a', name: 'PC' };

test('a session is on the computer it names', () => {
  assert.equal(isHere(session(pc), pc), true);
  assert.equal(isHere(session({ id: 'b', name: 'Other' }), pc), false);
  assert.equal(isHere(session(pc), null), false);
});

test('a session that names no computer is here unless its folder is known not to be', () => {
  assert.equal(isHere(session(undefined), pc), true);
  assert.equal(isHere(session(undefined), pc, new Set()), true);
  // Windows paths compare without regard to case or the kind of slash.
  assert.equal(isHere(session(undefined), pc, new Set(['d:\\work\\project'])), false);
  assert.equal(
    isHere(session(undefined, 'D:/work/project/'), pc, new Set(['d:\\work\\project'])),
    false,
  );
  // Before computers were told apart they were all Windows ones.
  assert.equal(isHere(session(undefined), { ...pc, platform: 'darwin' }), false);
  // A session that names a computer is not moved by what is on the disk.
  assert.equal(isHere(session(pc), pc, new Set(['d:\\work\\project'])), true);
});
