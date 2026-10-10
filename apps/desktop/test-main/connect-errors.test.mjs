import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  channelFailure,
  componentFailure,
  controlFailure,
  missingComponent,
} from '../electron/connect-errors.mjs';

const failure = (code, message = '') => Object.assign(new Error(message), { code });

test('a failed control connection says which step failed and what to check', () => {
  const target = 'cloud.example:8443';
  assert.match(controlFailure(failure('ENOTFOUND'), target), /无法解析.*cloud\.example。/);
  assert.match(controlFailure(failure('ECONNREFUSED'), target), /cloud\.example:8443 拒绝了连接/);
  assert.match(controlFailure(failure('ETIMEDOUT'), target), /超时[\s\S]*云安全组/);
  assert.match(controlFailure(new Error('Connection timed out'), target), /超时/);
  assert.match(controlFailure(failure('DEPTH_ZERO_SELF_SIGNED_CERT'), target), /SHA256 指纹/);
  assert.match(controlFailure(failure('ERR_TLS_CERT_ALTNAME_INVALID'), target), /主机名/);
  assert.match(controlFailure(failure('CERT_HAS_EXPIRED'), target), /已过期/);
  assert.match(controlFailure(failure('EPROTO'), target), /TLS/);
  assert.match(
    controlFailure(new Error('Unexpected server response: 502'), target),
    /502.*没有启动/,
  );
  assert.match(controlFailure(new Error('Unexpected server response: 404'), target), /WebSocket/);
  assert.match(controlFailure(new Error('Unexpected server response: 429'), target), /次数过多/);
  // The system proxy is named when the connection went through it, and blamed when it refused.
  const proxy = { host: '127.0.0.1', port: 7890 };
  assert.match(controlFailure(failure('ETIMEDOUT'), target, proxy), /系统代理 127\.0\.0\.1:7890/);
  assert.match(
    controlFailure(new Error('Proxy refused the connection: HTTP/1.1 403'), target, proxy),
    /系统代理 127\.0\.0\.1:7890拒绝转发/,
  );
  assert.match(
    controlFailure(failure('ESOMETHING'), target),
    /无法连接 cloud\.example:8443（ESOMETHING）/,
  );
});

test('a component that stopped is named, with the reason it gave', () => {
  assert.match(
    componentFailure('cc-desk-tunnel: sshd.exe exited 255\n', true),
    /sshd\.exe）已退出（退出代码 255）/,
  );
  // Windows would not start the program: 225 is its code for a file held to be malware.
  assert.match(
    componentFailure('cc-desk-tunnel: cannot start sshd.exe error 225\n', true),
    /sshd\.exe 被 Windows 或安全软件拦截[\s\S]*保护历史记录/,
  );
  assert.match(
    componentFailure('cc-desk-tunnel: cannot start sshd.exe error 193\n', true),
    /无法启动（系统错误 193）[\s\S]*重新安装/,
  );
  // Nothing said: early on that is what a quarantine looks like, later it is not.
  assert.match(componentFailure('', true), /没能启动[\s\S]*保护历史记录/);
  assert.match(componentFailure('', false), /已退出/);
  assert.match(missingComponent('sshd.exe'), /找不到随应用安装的 sshd\.exe/);
});

test('an execution channel that never got ready says what stood in the way', () => {
  const target = 'cloud.example:8443';
  // Channel connections could not be opened: the cause is the one a control connection would have reported.
  const limited = channelFailure(45, new Error('Unexpected server response: 429'), target, null);
  assert.match(limited, /^执行通道在 45 秒内没有就绪。\n.*次数过多/);
  assert.match(limited, /并发连接数/);
  assert.equal(limited.split('\n').length, 3);
  assert.match(
    channelFailure(45, failure('ECONNRESET'), target, { host: '10.0.0.1', port: 8080 }),
    /连接被中断/,
  );
  // They were opened, or none was ever asked for: the probe command itself went unanswered.
  assert.match(channelFailure(60, undefined, target, null), /60 秒[\s\S]*sshd\.exe 或 PowerShell/);
});
