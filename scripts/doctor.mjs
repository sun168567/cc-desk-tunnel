import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const major = Number(process.versions.node.split('.')[0]);
console.log(`Node.js: ${process.version} (${major === 24 ? 'OK' : '需要 24.x'})`);
console.log(`平台: ${process.platform}/${process.arch}`);

const git = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
console.log(
  `Git: ${git.status === 0 ? git.stdout.trim() : '检查失败：' + (git.error?.code ?? git.status)}`,
);

const npm =
  process.platform === 'win32'
    ? (process.env.PATH ?? '')
        .split(delimiter)
        .some((dir) => existsSync(join(dir.replace(/^"|"$/g, ''), 'npm.cmd')))
    : spawnSync('npm', ['--version'], { encoding: 'utf8' }).status === 0;
console.log(`npm: ${npm ? 'PATH 中可用' : '未找到；产品开发需安装 npm 并执行 npm ci'}`);

let shellReady = true;
if (process.platform === 'win32') {
  const pwsh = spawnSync(
    'pwsh.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'],
    { encoding: 'utf8', windowsHide: true },
  );
  shellReady = pwsh.status === 0 && Number(pwsh.stdout.trim()) >= 7;
  console.log(
    `PowerShell 7: ${shellReady ? 'OK' : '检查失败：' + (pwsh.error?.code ?? pwsh.status)}`,
  );
}

console.log('仅检测本机工具；未读取凭据，未连接 Ubuntu 或模型 API。');
if (major !== 24 || git.status !== 0 || !npm || !shellReady) process.exitCode = 1;
