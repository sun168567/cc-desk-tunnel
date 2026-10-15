import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, LogIn, LogOut } from 'lucide-react';
import { OpenAI } from '@lobehub/icons';
import type { AccountState } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { copyText } from './copy.tsx';

function limitText(limits: NonNullable<AccountState['limits']>) {
  if (!limits || limits.kind === 'none' || limits.memoryMb <= 0)
    return '当前系统没有施加内存和进程数限制。Linux 上优先使用 cgroup；写不了 cgroup 时改为限制 Codex 进程的地址空间和进程数。';
  const cpu =
    limits.cpu && limits.cpuMillis ? `，CPU ${limits.cpuMillis / 1000} 个核` : '';
  if (limits.kind === 'cgroup')
    return `内存上限 ${limits.memoryMb} MB，最多 ${limits.pids} 个进程${cpu}。限制在 Codex 进程组上，包含 Codex 工作进程，Claude 不在其中。`;
  return `虚拟内存上限 ${limits.memoryMb} MB，最多 ${limits.pids} 个进程。这台机器写不了 cgroup，所以没有 CPU 限额，限制的是地址空间而不是驻留内存，工作进程不在其中。`;
}

function runtimeText(account: AccountState | null) {
  if (!account || account.runtime === 'absent' || !account.runtime) return '未配置';
  if (account.runtime === 'unavailable') return '不可用';
  return '就绪';
}

function officialOpenAILogin(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'auth.openai.com';
  } catch {
    return false;
  }
}

export default function OpenAISettings({
  client,
  account,
}: {
  client: ProxyClient;
  account: AccountState | null;
  openAccount?: () => void;
}) {
  const [failure, setFailure] = useState('');
  const [path, setPath] = useState(account?.executable ?? '');
  const [saving, setSaving] = useState(false);
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);

  useEffect(() => {
    setPath(account?.executable ?? '');
  }, [account?.executable, account?.runtime]);

  useEffect(() => {
    void client.request({ type: 'account.status', provider: 'openai' }).catch((error: unknown) => {
      setFailure(error instanceof Error ? error.message : '没有读到 OpenAI 的状态。');
    });
  }, [client]);

  async function act(command: Parameters<ProxyClient['request']>[0]) {
    setFailure('');
    setWorking(true);
    try {
      await client.request(command);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '操作失败。');
    } finally {
      setWorking(false);
    }
  }

  async function savePath() {
    setSaving(true);
    setFailure('');
    try {
      await client.request({ type: 'openai.path', path });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '没有保存 Codex 路径。');
    } finally {
      setSaving(false);
    }
  }

  const absent = !account || account.runtime === 'absent' || !account.runtime;
  const loginUrl = account?.login?.url;
  const official = loginUrl ? officialOpenAILogin(loginUrl) : false;

  return (
    <section className="page" aria-label="OpenAI 设置">
      <div className="page-body">
        <h1 className="page-title page-title-with-icon">
          <OpenAI size={22} />
          OpenAI
        </h1>
        <p className="muted">
          Codex 单独运行。它没有配好、登录失败或进程超限时，Claude 的会话和连接保持可用。
        </p>
        {failure && (
          <p className="error-text" role="alert">
            {failure}
          </p>
        )}

        <h2 className="page-heading">账号</h2>
        <div className="account-identity" aria-label="OpenAI 账号">
          <div className="account-avatar">
            <OpenAI.Avatar size={44} shape="square" />
          </div>
          <div>
            <h2>
              {account?.loggedIn
                ? (account.email ?? 'OpenAI 已登录')
                : absent
                  ? '尚未配置 Codex'
                  : '尚未登录'}
            </h2>
            <p>
              {account?.loggedIn
                ? (account.authMethod ? `认证方式：${account.authMethod}` : '官方设备码登录 · 与 Claude 账号独立')
                : absent
                  ? '先在下方设置 Codex 可执行文件路径并启动，即可使用官方设备码登录'
                  : '官方设备码登录，浏览器确认后即完成，不需要再粘贴验证码'}
            </p>
          </div>
          {!account?.loggedIn && !loginUrl && (
            <button
              type="button"
              className="button primary"
              disabled={working || absent}
              onClick={() => {
                void act({ type: 'account.login', provider: 'openai' });
              }}
            >
              <LogIn />
              {working ? '获取设备码…' : '登录'}
            </button>
          )}
          {account?.loggedIn && !confirmLogout && (
            <button
              type="button"
              className="button secondary"
              disabled={working}
              onClick={() => setConfirmLogout(true)}
            >
              <LogOut />
              退出登录
            </button>
          )}
        </div>
        {account?.notice && !failure && <p className="muted">{account.notice}</p>}
        {account?.loggedIn && confirmLogout && (
          <div className="account-confirm" role="group" aria-label="确认退出 OpenAI">
            <p>退出后这个 OpenAI 配置的登录会被清除。Claude 账号和已有会话保留。</p>
            <button
              type="button"
              className="button secondary"
              disabled={working}
              onClick={() => setConfirmLogout(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="button danger"
              disabled={working}
              onClick={() => {
                void act({ type: 'account.logout', provider: 'openai' }).then(() =>
                  setConfirmLogout(false),
                );
              }}
            >
              <LogOut />
              退出登录
            </button>
          </div>
        )}
        {loginUrl && !account?.loggedIn && (
          <div className="account-login" aria-label="登录 OpenAI">
            <p>
              <strong>1</strong>
              {official
                ? '在浏览器打开 OpenAI 的设备码页面。'
                : '服务给出的链接不是 OpenAI 的登录地址，请核对后再打开。'}
            </p>
            <div className="account-login-actions">
              {official && (
                <button
                  type="button"
                  className="button primary"
                  onClick={() => {
                    if (window.desktop)
                      void window.desktop
                        .openExternal(loginUrl)
                        .catch(() => setFailure('无法打开浏览器，请复制链接。'));
                    else window.open(loginUrl, '_blank', 'noopener');
                  }}
                >
                  <ExternalLink />
                  打开登录页
                </button>
              )}
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  void copyText(loginUrl).then(
                    () => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    },
                    () => setFailure('复制失败，请重试。'),
                  );
                }}
              >
                {copied ? <Check /> : <Copy />}
                {copied ? '已复制' : '复制链接'}
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={working}
                onClick={() => {
                  void act({ type: 'account.cancel', provider: 'openai' });
                }}
              >
                取消
              </button>
            </div>
            {!official && <p className="muted">{loginUrl}</p>}
          </div>
        )}

        <h2 className="page-heading">运行</h2>
        <div className="settings-list card">
          <div className="setting-row">
            <span>
              <strong>状态</strong>
              <small>
                {absent
                  ? '服务端没有设置 CODEX_PATH，OpenAI 不会启动；Claude 不受影响'
                  : '由服务端的 CODEX_PATH 或下方配置决定是否启动'}
              </small>
            </span>
            <span className="setting-value">{runtimeText(account)}</span>
          </div>
          <div className="setting-row">
            <span>
              <strong>可执行文件</strong>
              <small>保存后只重新启动 Codex。留空则停用。找不到这个程序时，保留上一次可用的配置。</small>
            </span>
            <span className="setting-actions">
              <input
                className="path"
                aria-label="Codex 路径"
                placeholder="例如 /usr/local/bin/codex"
                value={path}
                spellCheck={false}
                onChange={(event) => setPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void savePath();
                }}
              />
              <button
                type="button"
                className="button"
                disabled={saving}
                onClick={() => void savePath()}
              >
                {saving ? '保存中' : '保存路径'}
              </button>
            </span>
          </div>
          {!absent && (
            <>
              <div className="setting-row">
                <span>
                  <strong>默认模型</strong>
                  <small>会话没有自选模型时使用。可在输入栏改这一次会话的模型</small>
                </span>
                <span className="setting-value">{account.defaultModel ?? 'Codex 自己的默认'}</span>
              </div>
              <div className="setting-row">
                <span>
                  <strong>资源限制</strong>
                  <small>
                    {account.limits
                      ? limitText(account.limits)
                      : '工作进程还没有报告限制。只约束 Codex 进程，不约束 Claude。'}
                  </small>
                </span>
                <span className="setting-value">
                  {account.limits?.kind === 'cgroup'
                    ? 'cgroup'
                    : account.limits?.kind === 'rlimit'
                      ? 'prlimit'
                      : '未限制'}
                </span>
              </div>
            </>
          )}
        </div>

        <h2 className="page-heading">审批与沙箱</h2>
        <p className="muted">
          每一轮开始时，输入栏里的模式会换成 Codex 自己的审批和沙箱，不会把 Claude
          的模式名原样传过去。安装的 Codex 若拒绝这些参数，计划模式和绕过权限不会开始这一轮，避免在没有沙箱的情况下运行。
        </p>
        <div className="settings-list card">
          <div className="setting-row">
            <span>
              <strong>自动审批 / 手动审批</strong>
              <small>自动和手动相同：需要确认时询问，工作区可写，可以经 SSH 访问你的电脑</small>
            </span>
            <span className="setting-value">按需询问 · 工作区可写</span>
          </div>
          <div className="setting-row">
            <span>
              <strong>接受编辑</strong>
              <small>接受编辑让文件修改直接通过，命令仍先询问</small>
            </span>
            <span className="setting-value">文件直通 · 命令询问</span>
          </div>
          <div className="setting-row">
            <span>
              <strong>计划模式</strong>
              <small>计划模式在这台服务器上只读，命令和文件修改会被拒绝</small>
            </span>
            <span className="setting-value">只读沙箱</span>
          </div>
          <div className="setting-row">
            <span>
              <strong>绕过权限</strong>
              <small>绕过权限不再询问，并关掉沙箱</small>
            </span>
            <span className="setting-value">无沙箱 · 免确认</span>
          </div>
        </div>
      </div>
    </section>
  );
}
