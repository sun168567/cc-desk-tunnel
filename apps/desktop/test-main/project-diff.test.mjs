import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { beginProjectDiff, finishProjectDiff, dropProjectDiff, parseStatus } = createRequire(
  import.meta.url,
)('../electron/project-diff.cjs');

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    windowsHide: true,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'diff',
      GIT_AUTHOR_EMAIL: 'diff@example.com',
      GIT_COMMITTER_NAME: 'diff',
      GIT_COMMITTER_EMAIL: 'diff@example.com',
    },
  });
  assert.equal(result.status, 0, result.stderr);
}

async function folder() {
  return mkdtemp(join(tmpdir(), 'project-diff-'));
}

test('status lines keep renames and untracked directories apart', () => {
  const entries = parseStatus(Buffer.from(' M src/a.ts\0R  old.ts\0new.ts\0?? dir/\0'));
  assert.deepEqual(entries, [
    { code: ' M', path: 'src/a.ts', from: null },
    { code: 'R ', path: 'new.ts', from: 'old.ts' },
    { code: '??', path: 'dir/', from: null },
  ]);
});

test('a plain folder reports files changed after the snapshot and skips dependency directories', async () => {
  const root = await folder();
  try {
    await writeFile(join(root, 'keep.txt'), 'same\n');
    await writeFile(join(root, 'change.txt'), 'before\n');
    await writeFile(join(root, 'gone.txt'), 'remove\n');
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'a.js'), 'old\n');
    await beginProjectDiff('plain', root);
    await writeFile(join(root, 'change.txt'), 'before\nafter\n');
    await writeFile(join(root, 'fresh.txt'), 'new\n');
    await rm(join(root, 'gone.txt'));
    await writeFile(join(root, 'node_modules', 'pkg', 'a.js'), 'new\n');
    const changes = await finishProjectDiff('plain');
    const byName = Object.fromEntries(
      changes.map((file) => [file.path.split(/[\\/]/).pop(), file]),
    );
    assert.equal(byName['keep.txt'], undefined);
    assert.equal(byName['a.js'], undefined);
    assert.equal(byName['change.txt'].oldText, 'before\n');
    assert.equal(byName['change.txt'].newText, 'before\nafter\n');
    assert.equal(byName['fresh.txt'].oldText, '');
    assert.equal(byName['fresh.txt'].newText, 'new\n');
    assert.equal(byName['gone.txt'].oldText, 'remove\n');
    assert.equal(byName['gone.txt'].newText, '');
    assert.equal(await finishProjectDiff('plain'), changes);
    assert.equal(await finishProjectDiff('missing'), null);
  } finally {
    await dropProjectDiff('plain');
    await rm(root, { recursive: true, force: true });
  }
});

test('a git repository shows only what changed during the turn', { skip: !hasGit }, async () => {
  const root = await folder();
  try {
    git(root, ['init', '-b', 'main']);
    await writeFile(join(root, 'a.txt'), 'alpha\n');
    await writeFile(join(root, 'b.txt'), 'beta\n');
    git(root, ['add', 'a.txt', 'b.txt']);
    git(root, ['commit', '-m', 'init']);
    await writeFile(join(root, 'a.txt'), 'alpha\nstale\n');
    await beginProjectDiff('repo', root);
    await writeFile(join(root, 'b.txt'), 'beta\nchanged\n');
    await writeFile(join(root, 'c.txt'), 'created\n');
    const changes = await finishProjectDiff('repo');
    const byName = Object.fromEntries(
      changes.map((file) => [file.path.split(/[\\/]/).pop(), file]),
    );
    assert.equal(byName['a.txt'], undefined);
    assert.equal(byName['b.txt'].oldText, 'beta\n');
    assert.equal(byName['b.txt'].newText, 'beta\nchanged\n');
    assert.equal(byName['c.txt'].oldText, '');
    assert.equal(byName['c.txt'].newText, 'created\n');
    await dropProjectDiff('repo');
    await beginProjectDiff('repo-dirty', root);
    await writeFile(join(root, 'a.txt'), 'alpha\nstale\nmore\n');
    const dirty = await finishProjectDiff('repo-dirty');
    const edited = dirty.find((file) => file.path.endsWith('a.txt'));
    assert.equal(edited.oldText, 'alpha\nstale\n');
    assert.equal(edited.newText, 'alpha\nstale\nmore\n');
  } finally {
    await dropProjectDiff('repo');
    await dropProjectDiff('repo-dirty');
    await rm(root, { recursive: true, force: true });
  }
});
