import assert from 'node:assert/strict';
import { test } from 'node:test';
import { upgradeText as said } from '../src/client-upgrade.ts';
import { t } from '../src/i18n.ts';

const upgradeText = (step, quiet) => said(t, step, quiet);

test('each step of a client upgrade reads as one line, and a wait long enough to look like a hang says how long', () => {
  const service = { source: 'service' };
  const github = { source: 'github' };
  assert.equal(upgradeText({ ...service, phase: 'connecting' }), '正在连接服务端…');
  assert.equal(upgradeText({ ...github, phase: 'connecting' }, 12), '正在连接 GitHub，已等 12 秒');
  const half = { ...github, phase: 'downloading', received: 50, size: 100 };
  assert.equal(upgradeText(half, 2), '正在从 GitHub 下载 50%');
  assert.equal(upgradeText(half, 8), '正在从 GitHub 下载 50%，8 秒没有新数据');
  assert.equal(
    upgradeText({ ...half, phase: 'retrying', attempt: 2, attempts: 5 }),
    '网络中断，正在重新连接（第 2/5 次）',
  );
  assert.equal(upgradeText({ ...half, phase: 'retrying', attempt: 0 }), '连接中断，正在续传…');
  assert.equal(
    upgradeText({ ...service, phase: 'installing' }),
    '正在安装，完成后客户端会自动打开',
  );
});
