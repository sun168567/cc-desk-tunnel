import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
async function git(cwd, ...args) {
  try {
    return (await run('git', ['-C', cwd, ...args], { timeout: 15000 })).stdout.trim();
  } catch (error) {
    throw new Error(
      String(error.stderr || error.message)
        .trim()
        .split('\n')
        .at(-1),
    );
  }
}

// The repository a directory belongs to: `root`, the directory of its main checkout, which every worktree of it
// shares; `top`, this checkout's own top directory; and the branch checked out there (null when detached). Null
// outside a repository, or in one without a commit yet.
export async function repositoryOf(path) {
  try {
    const [top, common, branch] = (
      await git(path, 'rev-parse', '--show-toplevel', '--git-common-dir', '--abbrev-ref', 'HEAD')
    ).split('\n');
    const commonDir = resolve(path, common);
    const root = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
    return { root, top, branch: branch === 'HEAD' ? null : branch };
  } catch {
    return null;
  }
}

// Where ccdt puts a repository's worktrees: beside the repository, in `<name>.worktrees/`.
export const worktreeHome = (root) => `${root}.worktrees`;
export const ownWorktree = (root, path) => {
  const inside = relative(worktreeHome(root), path);
  return !!inside && !inside.startsWith('..') && !inside.includes('/');
};

// A new worktree of the repository holding `project`, on `branch`: an existing branch is checked out, a new one
// starts from what `project` has checked out. Returns its directory.
export async function addWorktree(project, branch) {
  const repository = await repositoryOf(project);
  if (!repository) throw new Error(`不是有提交的 git 仓库：${project}`);
  await git(repository.root, 'check-ref-format', '--branch', branch).catch(() => {
    throw new Error(`分支名不可用：${branch}`);
  });
  const path = join(worktreeHome(repository.root), branch.replaceAll('/', '-'));
  await mkdir(worktreeHome(repository.root), { recursive: true });
  const exists = await git(
    repository.root,
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ).then(
    () => true,
    () => false,
  );
  if (exists) await git(repository.root, 'worktree', 'add', path, branch);
  else await git(project, 'worktree', 'add', '-b', branch, path, 'HEAD');
  return realpath(path);
}

// Removes a worktree ccdt made, refusing one with uncommitted changes. The branch stays for merging.
export async function removeWorktree(path) {
  const repository = await repositoryOf(path);
  if (!repository || !ownWorktree(repository.root, path))
    throw new Error(`不是 ccdt 创建的 worktree：${path}`);
  if (await git(path, 'status', '--porcelain'))
    throw new Error('worktree 里有未提交的改动，先提交或丢弃再删除。');
  await git(repository.root, 'worktree', 'remove', path);
  return repository.branch;
}
