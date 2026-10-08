import { useEffect, useState } from 'react';
import {
  UserRound,
  RefreshCw,
  Activity,
  ShieldCheck,
  LogIn,
  LogOut,
  ExternalLink,
  Copy,
  Check,
  ListOrdered,
} from 'lucide-react';
import type {
  AccountState,
  NativeCapabilities,
  NativeMetrics,
  UsageSummary,
} from '@cc-desk-tunnel/protocol';
import UsagePanel, { dollars, quotaName, tokens } from './UsagePanel.tsx';
import type { ProxyClient } from './client.ts';
import { IconButton } from './ui.tsx';

export default function AccountPanel({
  client,
  account: state,
  capabilities,
  metrics,
  refreshing,
  disabled,
  error,
  refresh,
}: {
  client: ProxyClient;
  account: AccountState | null;
  capabilities: NativeCapabilities | null;
  metrics: NativeMetrics | null;
  refreshing: boolean;
  disabled: boolean;
  error: string | null;
  refresh: () => void;
}) {
  const account = capabilities?.account;
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [copied, setCopied] = useState(false);
  const signedOut = state?.loggedIn === false;
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [log, setLog] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void client.fetch({ type: 'usage.summary' }).then(
      (result) => {
        if (current) setSummary(result);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [client, metrics?.rateLimits?.measuredAt, log]);
  if (log)
    return <UsagePanel client={client} summary={summary} initial={log} back={() => setLog(null)} />;
  async function act(command: Parameters<ProxyClient['request']>[0]) {
    setFailure(null);
    setWorking(true);
    try {
      await client.request(command);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '操作失败。');
    } finally {
      setWorking(false);
    }
  }
  return (
    <section className="account-page" aria-label="账号信息">
      <header className="account-heading">
        <h1>
          <UserRound />
          账号
        </h1>
        <IconButton title="刷新账号信息" disabled={disabled} onClick={refresh}>
          <RefreshCw className={refreshing ? 'spinning' : ''} />
        </IconButton>
      </header>
      <div className="account-body">
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="account-identity">
          <div className="account-avatar">
            <UserRound />
          </div>
          <div>
            <h2>{signedOut ? '尚未登录' : (state?.email ?? account?.email ?? 'Claude Code')}</h2>
            <p>
              {signedOut
                ? '云端 Claude Code 还没有登录账号'
                : (state?.subscriptionType ?? account?.subscriptionType ?? '账号信息尚未读取')}
            </p>
          </div>
          {signedOut && !state.login && (
            <button
              type="button"
              className="button primary"
              disabled={working}
              onClick={() => {
                void act({ type: 'account.login' });
              }}
            >
              <LogIn />
              {working ? '获取链接…' : '登录'}
            </button>
          )}
          {state?.loggedIn && !confirmLogout && (
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
        {(failure ?? state?.notice) && (
          <p className="error-text" role="alert">
            {failure ?? state?.notice}
          </p>
        )}
        {state?.loggedIn && confirmLogout && (
          <div className="account-confirm" role="group" aria-label="确认退出登录">
            <p>退出后云端的登录凭据会被官方 CLI 清除，会话记录保留；再次使用需要重新登录。</p>
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
                void act({ type: 'account.logout' }).then(() => setConfirmLogout(false));
              }}
            >
              <LogOut />
              退出登录
            </button>
          </div>
        )}
        {signedOut && state.login && (
          <form
            className="account-login"
            aria-label="登录 Claude 账号"
            onSubmit={(event) => {
              event.preventDefault();
              void act({ type: 'account.code', code: code.trim() }).then(() => setCode(''));
            }}
          >
            <p>
              <strong>1</strong>在浏览器打开官方授权页并登录。
            </p>
            <div className="account-login-actions">
              <button
                type="button"
                className="button primary"
                onClick={() => {
                  if (window.desktop)
                    void window.desktop
                      .openExternal(state.login!.url)
                      .catch(() => setFailure('无法打开浏览器，请复制链接。'));
                  else window.open(state.login!.url, '_blank', 'noopener');
                }}
              >
                <ExternalLink />
                打开授权页
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(state.login!.url).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  });
                }}
              >
                {copied ? <Check /> : <Copy />}
                {copied ? '已复制' : '复制链接'}
              </button>
            </div>
            <p>
              <strong>2</strong>把授权页最后显示的代码粘贴到这里。
            </p>
            <input
              aria-label="授权码"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              required
            />
            <div className="account-login-actions">
              <button
                type="button"
                className="button secondary"
                disabled={working}
                onClick={() => {
                  void act({ type: 'account.cancel' });
                }}
              >
                取消
              </button>
              <button className="button primary" disabled={working || !code.trim()}>
                <Check />
                完成登录
              </button>
            </div>
          </form>
        )}
        <dl className="account-details">
          <div>
            <dt>组织</dt>
            <dd>{account?.organization ?? '未提供'}</dd>
          </div>
          <div>
            <dt>模型服务</dt>
            <dd>
              {account?.apiProvider === 'firstParty'
                ? 'Anthropic'
                : (account?.apiProvider ?? '未读取')}
            </dd>
          </div>
          <div>
            <dt>认证来源</dt>
            <dd>{account?.tokenSource ?? account?.apiKeySource ?? '未提供'}</dd>
          </div>
        </dl>
        <h2 className="account-section-title">
          <Activity />
          订阅用量
          <button type="button" className="button secondary" onClick={() => setLog('today')}>
            <ListOrdered />
            调用日志
          </button>
        </h2>
        {metrics?.rateLimits?.available ? (
          <div className="quota-list">
            {metrics.rateLimits.windows.map((window, index) => (
              <div className="quota-row" key={`${window.name}:${index}`}>
                <div>
                  <strong>{quotaName(window.name) ?? window.name}</strong>
                  <span>
                    {window.utilization == null
                      ? '使用量未提供'
                      : `${window.utilization}% 已用 · ${Math.max(0, 100 - window.utilization)}% 剩余`}
                  </span>
                </div>
                {window.utilization != null && (
                  <progress max={100} value={Math.min(100, window.utilization)} />
                )}
                <small>
                  {window.resetsAt
                    ? `重置：${new Date(window.resetsAt).toLocaleString('zh-CN')}`
                    : '重置时间未提供'}
                </small>
                {(() => {
                  const period = summary?.windows.find((item) => item.name === window.name);
                  return (
                    period && (
                      <button
                        type="button"
                        className="quota-period"
                        title="查看本周期的调用日志"
                        onClick={() => setLog(window.name)}
                      >
                        本周期 {period.requests.toLocaleString('zh-CN')} 次请求 ·{' '}
                        {tokens(
                          period.inputTokens +
                            period.outputTokens +
                            period.cacheReadTokens +
                            period.cacheCreationTokens,
                        )}{' '}
                        tokens · 等价 {dollars(period.costUsd)}
                      </button>
                    )
                  );
                })()}
              </div>
            ))}
            {!metrics.rateLimits.windows.length && (
              <p className="muted">原生接口未返回额度窗口。</p>
            )}
            <p className="account-updated">
              {metrics.rateLimits.measuredAt &&
                `更新于 ${new Date(metrics.rateLimits.measuredAt).toLocaleTimeString('zh-CN')}`}
            </p>
          </div>
        ) : (
          <p className="muted">
            {metrics?.errors?.usage ??
              (metrics?.rateLimits ? '当前账号未提供订阅额度' : '等待读取原生额度')}
          </p>
        )}
        <h2 className="account-section-title">
          <ShieldCheck />
          当前会话
        </h2>
        <dl className="account-details">
          <div>
            <dt>输入 / 输出</dt>
            <dd>
              {metrics?.usage
                ? `${metrics.usage.inputTokens.toLocaleString()} / ${metrics.usage.outputTokens.toLocaleString()} tokens`
                : '等待读取'}
            </dd>
          </div>
          <div>
            <dt>缓存读取 / 写入</dt>
            <dd>
              {metrics?.usage
                ? `${metrics.usage.cacheReadTokens.toLocaleString()} / ${metrics.usage.cacheWriteTokens.toLocaleString()} tokens`
                : '等待读取'}
            </dd>
          </div>
          <div>
            <dt>原生费用估算</dt>
            <dd>
              {metrics?.usage?.costUsd != null
                ? `$${metrics.usage.costUsd.toFixed(4)}（非订阅账单）`
                : '未提供'}
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
