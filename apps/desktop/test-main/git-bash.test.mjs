import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findGitBash } from '../electron/git-bash.mjs';

// What a computer has: the folders that exist, by their Windows paths.
const computer = (...paths) => {
  const files = new Set(paths.map((path) => path.toLowerCase()));
  return (path) => files.has(path.toLowerCase());
};

test('Git Bash is found where the installer of Git for Windows put it, whatever the PATH holds', async () => {
  assert.equal(
    await findGitBash({
      env: { PATH: 'C:\\Windows\\System32' },
      roots: async () => ['D:\\Tools\\Git'],
      exists: computer('D:\\Tools\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'),
    }),
    'D:\\Tools\\Git\\bin\\bash.exe',
  );
});

test('a copy of Git unpacked by hand is found beside its git on the PATH', async () => {
  for (const folder of ['cmd', 'bin', 'mingw64\\bin'])
    assert.equal(
      await findGitBash({
        env: { Path: `C:\\Windows;E:\\PortableGit\\${folder}` },
        roots: async () => [],
        exists: computer(`E:\\PortableGit\\${folder}\\git.exe`, 'E:\\PortableGit\\bin\\bash.exe'),
      }),
      'E:\\PortableGit\\bin\\bash.exe',
    );
});

test('without a record or a git on the PATH, the folders the installer uses by default are tried', async () => {
  const env = {
    PATH: '',
    ProgramFiles: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  };
  assert.equal(
    await findGitBash({
      env,
      roots: async () => [],
      exists: computer('C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'),
    }),
    'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe',
  );
  // The bash.exe of WindowsApps or System32 starts WSL, and is never taken for Git Bash.
  assert.equal(
    await findGitBash({
      env: {
        ...env,
        PATH: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Windows\\System32',
      },
      roots: async () => [],
      exists: computer(
        'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',
        'C:\\Windows\\System32\\bash.exe',
      ),
    }),
    undefined,
  );
});
