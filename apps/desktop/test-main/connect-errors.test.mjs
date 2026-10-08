import assert from 'node:assert/strict';
import { test } from 'node:test';
import { componentFailure, controlFailure, missingComponent } from '../electron/connect-errors.mjs';

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
  const tunnel = 'cloud.example:7000';
  const frpc = (log, early = true) =>
    componentFailure(`${log}\ncc-desk-tunnel: frpc.exe exited 1\n`, tunnel, early);
  assert.match(
    frpc('login to the server failed: dial tcp 203.0.113.9:7000: i/o timeout'),
    /隧道端口 cloud\.example:7000 超时[\s\S]*放行/,
  );
  assert.match(
    frpc('connectex: No connection could be made because the target machine actively refused it.'),
    /拒绝了连接/,
  );
  assert.match(frpc('tls: failed to verify certificate: x509: unknown authority'), /证书校验失败/);
  // Nothing said: early on that is what a quarantine looks like, later it is not.
  assert.match(frpc(''), /启动后随即退出（退出代码 1）[\s\S]*保护历史记录[\s\S]*7000/);
  assert.match(frpc('', false), /连接建立后退出/);
  assert.match(
    componentFailure('cc-desk-tunnel: sshd.exe exited 255\n', tunnel, true),
    /sshd\.exe）已退出（退出代码 255）/,
  );
  // Windows would not start the program: 225 is its code for a file held to be malware.
  assert.match(
    componentFailure('cc-desk-tunnel: cannot start frpc.exe error 225\n', tunnel, true),
    /frpc\.exe 被 Windows 或安全软件拦截[\s\S]*保护历史记录/,
  );
  assert.match(
    componentFailure('cc-desk-tunnel: cannot start frpc.exe error 193\n', tunnel, true),
    /无法启动（系统错误 193）[\s\S]*重新安装/,
  );
  assert.match(componentFailure('', tunnel, true), /没能启动/);
  assert.match(missingComponent('frpc.exe'), /找不到随应用安装的 frpc\.exe/);
});
