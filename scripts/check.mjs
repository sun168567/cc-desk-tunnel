import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const errors = [];
const git = (...args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const files = git('ls-files', '-z').split('\0').filter(Boolean);
const privatePath =
  /(^|\/)(?:\.local|node_modules|dist|coverage)(?:\/|$)|(^|\/)\.env(?:\.|$)|\.local\.json$|\.(?:pem|key|p12|pfx)$/i;
const secretToken = /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/;
const privateKey = /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/;
// Public, test-only keys. Any change requires reviewing the entire fixture and its hash;
// this does not exempt other files or token-like secrets in the fixture.
const publicTestKeys = new Map([
  [
    'apps/server/test/fixtures/web-certificates.ts',
    '501efd4fc27c5d3103247d9ef0f44f16fbb683e0645ec5b6152c01d37b27bb48',
  ],
]);

for (const file of files) {
  if (privatePath.test(file) && !file.endsWith('.env.example')) {
    errors.push('禁止跟踪的文件路径：' + file);
  }
  if (!/\.(?:md|mjs|cjs|ts|tsx|html|css|json|txt|sh|ps1)$/.test(file)) continue;
  const content = git('show', ':' + file);
  const reviewedKeys =
    publicTestKeys.get(file) === createHash('sha256').update(content).digest('hex');
  if (secretToken.test(content) || (privateKey.test(content) && !reviewedKeys)) {
    errors.push('疑似秘密：' + file + '（内容不显示）');
  }
  if (file.endsWith('.json')) {
    try {
      JSON.parse(content);
    } catch {
      errors.push('JSON 无效：' + file);
    }
  }
  // The /bin/sh of macOS, bash 3.2, takes a byte of a character after a name as part of the name: `$rc）` asks for a
  // variable that is not there. A name followed by anything but ASCII is written in braces.
  if (file.endsWith('.sh')) {
    for (const [index, line] of content.split('\n').entries())
      if (/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line))
        errors.push('shell 变量名后紧跟非 ASCII 字符，应写成 ${名字}：' + file + ':' + (index + 1));
  }
  // Windows PowerShell 5.1 reads a script file without a BOM in the system's code page, GBK on a Chinese Windows, where
  // its characters swallow the quotes after them. A script run as a file and holding anything but ASCII starts with a
  // BOM; the one piped to iex does not, as there the BOM is taken for part of the first command.
  if (file.endsWith('.ps1')) {
    const piped = file === 'deploy/install-ccdt.ps1';
    if (piped && content.startsWith('\uFEFF')) errors.push('经 iex 运行的脚本不能带 BOM：' + file);
    if (!piped && !content.startsWith('\uFEFF') && /[^\x00-\x7F]/.test(content))
      errors.push('含非 ASCII 字符的 PowerShell 脚本应以 UTF-8 BOM 开头：' + file);
  }
  if (file.endsWith('.md')) {
    for (const match of content.matchAll(/\]\(([^\s)]+)\)/g)) {
      const link = match[1];
      if (/^(?:[a-z]+:|#)/i.test(link)) continue;
      const target = decodeURIComponent(link.split('#')[0]);
      if (!existsSync(resolve(root, dirname(file), target))) {
        errors.push('本地文档链接失效：' + file + ' → ' + target);
      }
    }
  }
}

for (const path of ['.local/开发调试凭据.txt', '.env', 'config/runtime.local.json']) {
  try {
    git('check-ignore', '--no-index', '--', path);
  } catch {
    errors.push('应被忽略的路径未被忽略：' + path);
  }
}

const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
for (const workspace of manifest.workspaces) {
  const path = resolve(root, workspace, 'package.json');
  if (!existsSync(path)) errors.push('缺少 workspace 清单：' + workspace);
  else if (!JSON.parse(readFileSync(path, 'utf8')).private) {
    errors.push('workspace 应设置 private：' + workspace);
  }
}

if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(
    'PASS：检查 ' + files.length + ' 个索引文件、workspace 清单、文档链接及秘密忽略规则。',
  );
  console.log('此检查不访问模型或虚拟机，也不代表代理产品已实现或实测。');
}
