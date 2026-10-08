import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { gitBranch } = createRequire(import.meta.url)('../electron/git-branch.cjs');

test('the branch is read from the repository files, from any directory inside it', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'git-branch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(await gitBranch(join(root, '不存在')), null);

  const repository = join(root, '仓库');
  mkdirSync(join(repository, '.git'), { recursive: true });
  mkdirSync(join(repository, 'src', '深'), { recursive: true });
  writeFileSync(join(repository, '.git', 'HEAD'), 'ref: refs/heads/dev/功能\n');
  assert.equal(await gitBranch(repository), 'dev/功能');
  assert.equal(await gitBranch(join(repository, 'src', '深')), 'dev/功能');

  // A detached HEAD is named by its commit.
  writeFileSync(join(repository, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
  assert.equal(await gitBranch(repository), '0123456');

  // A linked working tree keeps its HEAD in the directory its .git file names.
  const linked = join(root, '工作树');
  mkdirSync(join(repository, '.git', 'worktrees', 'w'), { recursive: true });
  mkdirSync(linked);
  writeFileSync(join(repository, '.git', 'worktrees', 'w', 'HEAD'), 'ref: refs/heads/side\n');
  writeFileSync(join(linked, '.git'), `gitdir: ${join(repository, '.git', 'worktrees', 'w')}\n`);
  assert.equal(await gitBranch(linked), 'side');
});
