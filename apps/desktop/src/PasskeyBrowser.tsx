import { useEffect, useRef, useState } from 'react';
import { Check, Fingerprint } from 'lucide-react';
import {
  cancelPasskey,
  loadPasskeyRegistration,
  passkeyError,
  passkeySupportError,
  registerPasskey,
} from './passkey.ts';
import type { PasskeyLink, PasskeyRegistrationOptions } from './passkey.ts';

export default function PasskeyBrowser({ link }: { link: PasskeyLink }) {
  const passkeySupport = passkeySupportError();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [details, setDetails] = useState<PasskeyRegistrationOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [expired, setExpired] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setDetails(null);
    setExpired(false);
    void loadPasskeyRegistration(link.token, controller.signal)
      .then(
        (value) => {
          if (controller.signal.aborted) return;
          setDetails(value);
          if (!passkeySupport) void confirm(value);
        },
        (error: unknown) => {
          if (!controller.signal.aborted) setError(passkeyError(error));
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      pending.current?.abort();
      cancelPasskey();
    };
  }, [link, attempt]);
  useEffect(() => {
    if (!details || done) return;
    const delay = Math.max(0, Date.parse(details.expiresAt) - Date.now());
    const timer = setTimeout(() => {
      setExpired(true);
      pending.current?.abort();
      cancelPasskey();
      setBusy(false);
    }, delay);
    return () => clearTimeout(timer);
  }, [details, done]);
  async function confirm(options: PasskeyRegistrationOptions) {
    if (pending.current || done || passkeySupport) return;
    if (Date.parse(options.expiresAt) <= Date.now()) {
      setExpired(true);
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    try {
      await registerPasskey(options, controller.signal);
      if (!controller.signal.aborted) setDone(true);
    } catch (error) {
      if (!controller.signal.aborted)
        setError(
          error instanceof Error && ['NotAllowedError', 'AbortError'].includes(error.name)
            ? '创建未完成或已取消，请重试。'
            : `${passkeyError(error)} 若已在系统中确认，请返回客户端查看结果。`,
        );
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <main className="web-login">
      <section className="web-login-body passkey-authorization" aria-busy={busy}>
        <h1>{done ? '设置完成' : '创建通行密钥'}</h1>
        <p className="muted">CC Desk Tunnel · {location.host}</p>
        {done ? (
          <>
            <p className="passkey-complete" role="status">
              <Check aria-hidden="true" />
              通行密钥已保存，请返回客户端。
            </p>
            <p className="muted">可以关闭此页面。</p>
          </>
        ) : (
          <>
            <p>为此服务器添加通行密钥，用于登录 Web 工作台。</p>
            {details && (
              <p>
                通行密钥名称：<strong>{details.name}</strong>
              </p>
            )}
            {loading && !busy && <p role="status">正在读取授权请求…</p>}
            {expired && (
              <p role="alert" className="error">
                授权已过期，请返回客户端重新发起。
              </p>
            )}
            {passkeySupport && (
              <p role="alert" className="error">
                {passkeySupport}
              </p>
            )}
            {error && !expired && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            {!details && !loading && (
              <button className="button" onClick={() => setAttempt((value) => value + 1)}>
                重新读取
              </button>
            )}
            <button
              className="button primary"
              disabled={busy || loading || !details || expired || !!passkeySupport}
              aria-label={busy ? '等待系统验证…' : undefined}
              onClick={() => setAttempt((value) => value + 1)}
            >
              <Fingerprint aria-hidden="true" />
              <span role={busy ? 'status' : undefined}>
                {busy ? '等待系统验证…' : error && details ? '重新创建' : '创建通行密钥'}
              </span>
            </button>
          </>
        )}
      </section>
    </main>
  );
}
