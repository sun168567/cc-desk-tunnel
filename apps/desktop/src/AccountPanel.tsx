import { useEffect, useState } from 'react';
import {
  UserRound,
  RefreshCw,
  LogIn,
  LogOut,
  ExternalLink,
  Copy,
  Check,
  ListOrdered,
  KeyRound,
  LoaderCircle,
} from 'lucide-react';
import type {
  AccountState,
  AccountQuota,
  NativeCapabilities,
  UsageSummary,
} from '@cc-desk-tunnel/protocol';
import { wordsText } from '@cc-desk-tunnel/i18n';
import { localeOf, type T, useT } from './i18n.ts';
import UsagePanel, { dollars, quotaName, tokens } from './UsagePanel.tsx';
import type { ProxyClient } from './client.ts';
import { IconButton, Page, Row, Switch } from './ui.tsx';
import { setPrefs, usePrefs } from './prefs.ts';
import { copyText } from './copy.tsx';
import HelpLink from './HelpLink.tsx';

// What the date a stored claude.ai sign-in ends means for the user. Renewing the access token does not move it; the
// CLI starts warning ten days before it.
function loginExpiry(t: T, expiresAt: string, now = Date.now()) {
  const days = Math.ceil((Date.parse(expiresAt) - now) / 86_400_000);
  if (days <= 0) return <span className="error-text">{t('account:login.expired')}</span>;
  if (days <= 10)
    return <span className="error-text">{t('account:login.expiresSoon', { count: days })}</span>;
  return t('account:login.expiresLater', { count: days });
}

export default function AccountPanel({
  client,
  account: state,
  capabilities,
  quota,
  refreshing,
  disabled,
  error,
  refresh,
  usageOnly = false,
  quotaUnavailable,
}: {
  client: ProxyClient;
  account: AccountState | null;
  capabilities: NativeCapabilities | null;
  quota: AccountQuota | null;
  refreshing: boolean;
  disabled: boolean;
  error: string | null;
  refresh: () => void;
  usageOnly?: boolean;
  quotaUnavailable?: string;
}) {
  const t = useT();
  const account = capabilities?.account;
  const { quotaReads } = usePrefs();
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [code, setCode] = useState('');
  // A code handed to the official command, until it answers: a new link, an end, or something to say.
  const [codeSent, setCodeSent] = useState(false);
  useEffect(() => setCodeSent(false), [state?.login?.url, state?.notice]);
  const [token, setToken] = useState('');
  const [tokenOpen, setTokenOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [copied, setCopied] = useState(false);
  const signedOut = state?.loggedIn === false;
  const usesToken = state?.authMethod === 'oauth_token';
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
  }, [client, quota?.rateLimits?.measuredAt, log]);
  if (log && !usageOnly)
    return <UsagePanel client={client} summary={summary} initial={log} back={() => setLog(null)} />;
  async function act(command: Parameters<ProxyClient['request']>[0]) {
    setFailure(null);
    setWorking(true);
    try {
      await client.request(command);
      return true;
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t('account:failed'));
      return false;
    } finally {
      setWorking(false);
    }
  }
  return (
    <Page
      title={usageOnly ? t('account:usageTitle') : t('account:title')}
      label={usageOnly ? t('account:usageTitle') : t('account:infoTitle')}
      intro={!usageOnly && t('account:intro')}
      actions={
        <IconButton
          title={usageOnly ? t('account:refreshUsage') : t('account:refreshInfo')}
          className={usageOnly ? 'quota-page-refresh' : undefined}
          disabled={disabled}
          onClick={refresh}
        >
          <RefreshCw className={refreshing ? 'spinning' : ''} />
        </IconButton>
      }
    >
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {!usageOnly && (
        <div className="card account-card">
          <div className="account-identity">
            <div className="account-avatar">
              <UserRound />
            </div>
            <div>
              <h2>
                {signedOut
                  ? t('account:login.none')
                  : usesToken
                    ? t('account:login.tokenSet')
                    : (state?.email ?? account?.email ?? 'Claude Code')}
              </h2>
              <p>
                {signedOut
                  ? t('account:login.noneDetail')
                  : usesToken
                    ? t('account:login.tokenDetail')
                    : (state?.subscriptionType ??
                      account?.subscriptionType ??
                      t('account:login.notRead'))}
              </p>
            </div>
            {signedOut && !state.login && !tokenOpen && (
              <div className="account-login-actions">
                <button
                  type="button"
                  className="button primary"
                  disabled={working}
                  onClick={() => {
                    void act({ type: 'account.login' });
                  }}
                >
                  <LogIn />
                  {working ? t('account:login.gettingLink') : t('account:login.browser')}
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={working}
                  onClick={() => setTokenOpen(true)}
                >
                  <KeyRound />
                  {t('account:login.token')}
                </button>
              </div>
            )}
            {state?.loggedIn && !confirmLogout && (
              <button
                type="button"
                className="button secondary"
                disabled={working}
                onClick={() => setConfirmLogout(true)}
              >
                <LogOut />
                {t('account:login.signOut')}
              </button>
            )}
          </div>
          {(failure ?? state?.notice) && (
            <p className="error-text" role="alert">
              {failure ?? (state?.notice && wordsText(t, state.notice))}
            </p>
          )}
          {signedOut && !state.login && !tokenOpen && (
            <p className="muted">{t('account:login.tokenLimits')}</p>
          )}
          {state?.loggedIn && confirmLogout && (
            <div
              className="account-confirm"
              role="group"
              aria-label={t('account:login.confirmSignOut')}
            >
              <p>
                {usesToken ? t('account:login.signOutToken') : t('account:login.signOutBrowser')}
              </p>
              <button
                type="button"
                className="button secondary"
                disabled={working}
                onClick={() => setConfirmLogout(false)}
              >
                {t('common:cancel')}
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
                {t('account:login.signOut')}
              </button>
            </div>
          )}
          {signedOut && tokenOpen && !state.login && (
            <form
              className="account-login setup-token-login"
              aria-label={t('account:login.useToken')}
              onSubmit={(event) => {
                event.preventDefault();
                void act({ type: 'account.token', token: token.trim() }).then((saved) => {
                  if (saved) {
                    setToken('');
                    setTokenOpen(false);
                  }
                });
              }}
            >
              <p>{t('account:login.noToken')}</p>
              <button
                type="button"
                className="button secondary"
                disabled={working}
                onClick={() => {
                  void act({ type: 'account.login', method: 'setup-token' }).then((started) => {
                    if (started) {
                      setToken('');
                      setTokenOpen(false);
                    }
                  });
                }}
              >
                <ExternalLink />
                {working ? t('account:login.gettingLink') : t('account:login.generate')}
              </button>
              <p>{t('account:login.haveToken')}</p>
              <input
                type="password"
                aria-label="Setup token"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="new-password"
                spellCheck={false}
                maxLength={8192}
                required
              />
              <p className="muted">{t('account:login.tokenKept')}</p>
              <div className="account-login-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={working}
                  onClick={() => {
                    setToken('');
                    setTokenOpen(false);
                    setFailure(null);
                  }}
                >
                  {t('common:cancel')}
                </button>
                <button className="button primary" disabled={working || !token.trim()}>
                  <Check />
                  {working ? t('account:login.saving') : t('account:login.saveUse')}
                </button>
              </div>
            </form>
          )}
          {signedOut && state.login && (
            <form
              className="account-login"
              aria-label={t('account:login.title')}
              onSubmit={(event) => {
                event.preventDefault();
                void act({ type: 'account.code', code: code.trim() }).then((sent) => {
                  setCode('');
                  setCodeSent(sent);
                });
              }}
            >
              {state.login.method === 'setup-token' && <p>{t('account:login.generating')}</p>}
              <p>
                <strong>1</strong>
                {t('account:login.openStep')}
              </p>
              <div className="account-login-actions">
                <button
                  type="button"
                  className="button primary"
                  onClick={() => {
                    if (window.desktop)
                      void window.desktop
                        .openExternal(state.login!.url)
                        .catch(() => setFailure(t('account:login.openFailed')));
                    else window.open(state.login!.url, '_blank', 'noopener');
                  }}
                >
                  <ExternalLink />
                  {t('account:login.open')}
                </button>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    void copyText(state.login!.url).then(
                      () => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      },
                      () => setFailure(t('account:login.copyFailed')),
                    );
                  }}
                >
                  {copied ? <Check /> : <Copy />}
                  {copied ? t('common:copy.done') : t('account:login.copyLink')}
                </button>
              </div>
              <p>
                <strong>2</strong>
                {t('account:login.codeStep')}
              </p>
              <input
                aria-label={t('account:login.code')}
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
                  {t('common:cancel')}
                </button>
                <button className="button primary" disabled={working || codeSent || !code.trim()}>
                  {codeSent ? <LoaderCircle className="spinning" /> : <Check />}
                  {codeSent ? t('account:login.confirming') : t('account:login.finish')}
                </button>
              </div>
            </form>
          )}
          <Row title={t('account:info.method')}>
            <span className="setting-value">
              {signedOut
                ? t('account:login.none')
                : usesToken
                  ? 'Setup token'
                  : state?.authMethod === 'claude.ai'
                    ? t('account:info.browser')
                    : (state?.authMethod ?? t('account:info.notRead'))}
            </span>
          </Row>
          <Row title={t('account:info.organization')}>
            <span className="setting-value">
              {usesToken
                ? t('account:info.tokenNone')
                : (account?.organization ?? t('account:info.none'))}
            </span>
          </Row>
          <Row title={t('account:info.provider')}>
            <span className="setting-value">
              {account?.apiProvider === 'firstParty'
                ? 'Anthropic'
                : (account?.apiProvider ?? t('account:info.notRead'))}
            </span>
          </Row>
          <Row title={t('account:info.source')}>
            <span className="setting-value">
              {usesToken
                ? 'Setup token'
                : (account?.tokenSource ?? account?.apiKeySource ?? t('account:info.none'))}
            </span>
          </Row>
          {state?.loggedIn && state.loginExpiresAt && (
            <Row title={t('account:info.expiry')} detail={loginExpiry(t, state.loginExpiresAt)}>
              <span className="setting-value">
                {new Date(state.loginExpiresAt).toLocaleDateString('zh-CN')}
              </span>
            </Row>
          )}
        </div>
      )}
      {!usageOnly && (
        <div className="page-heading account-section-title">
          <h2>
            {t('account:usageTitle')}
            <HelpLink article="quota" title={t('account:quota.help')} />
          </h2>
          <button type="button" className="button secondary" onClick={() => setLog('today')}>
            <ListOrdered />
            {t('account:usage.title')}
          </button>
        </div>
      )}
      <div className={`card account-card${usageOnly ? ' quota-card' : ''}`}>
        {quota?.rateLimits?.available ? (
          <div className="quota-list">
            {quota.rateLimits.windows.map((window, index) => (
              <div className="quota-row" key={`${window.name}:${index}`}>
                <div>
                  <strong>{quotaName(t, window.name) ?? window.name}</strong>
                  <span>
                    {window.utilization == null
                      ? t('account:quota.noUtilization')
                      : t('account:quota.utilization', {
                          used: window.utilization,
                          left: Math.max(0, 100 - window.utilization),
                        })}
                  </span>
                </div>
                {window.utilization != null && (
                  <progress max={100} value={Math.min(100, window.utilization)} />
                )}
                <small>
                  {window.resetsAt
                    ? t('account:quota.resets', {
                        time: new Date(window.resetsAt).toLocaleString(localeOf(t)),
                      })
                    : t('account:quota.noReset')}
                </small>
                {(() => {
                  const period = summary?.windows.find((item) => item.name === window.name);
                  if (!period) return null;
                  const text = t('account:quota.period', {
                    count: period.requests,
                    n: period.requests.toLocaleString(localeOf(t)),
                    tokens: tokens(
                      t,
                      period.inputTokens +
                        period.outputTokens +
                        period.cacheReadTokens +
                        period.cacheCreationTokens,
                    ),
                    cost: dollars(period.costUsd),
                  });
                  return usageOnly ? (
                    <span className="quota-period">{text}</span>
                  ) : (
                    <button
                      type="button"
                      className="quota-period"
                      title={t('account:quota.periodLog')}
                      onClick={() => setLog(window.name)}
                    >
                      {text}
                    </button>
                  );
                })()}
              </div>
            ))}
            {!quota.rateLimits.windows.length && (
              <p className="muted">{t('account:quota.noWindows')}</p>
            )}
            <p className="account-updated">
              {quota.rateLimits.measuredAt &&
                t('account:quota.measured', {
                  time: new Date(quota.rateLimits.measuredAt).toLocaleTimeString(localeOf(t)),
                })}
            </p>
          </div>
        ) : (
          <p className="muted">
            {(quota?.error && wordsText(t, quota.error)) ??
              quotaUnavailable ??
              (quota?.rateLimits ? t('account:quota.notProvided') : t('account:quota.waiting'))}
          </p>
        )}
        <Row title={t('account:quota.poll')} detail={t('account:quota.pollDetail')}>
          <Switch
            label={t('account:quota.poll')}
            checked={quotaReads}
            onChange={(value) => setPrefs((prefs) => ({ ...prefs, quotaReads: value }))}
          />
        </Row>
      </div>
    </Page>
  );
}
