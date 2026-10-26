import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ProofInput } from './passkey.ts';
import { Modal } from './ui.tsx';
import {
  cancelPasskey,
  passkeyError,
  passkeySupportError,
  proveWithPasskey,
  usePasskeyOptions,
} from './passkey.ts';

export const message = (error: unknown) =>
  error instanceof Error ? error.message : '请求失败，请重试。';

export function ProofFields({
  proof,
  change,
  totp,
  passkeyAvailable = false,
}: {
  proof: ProofInput;
  change: (value: ProofInput) => void;
  totp: boolean;
  passkeyAvailable?: boolean;
}) {
  const usingPasskey = 'passkey' in proof;
  const supported = !passkeySupportError();
  const {
    options,
    error: optionsError,
    refresh,
  } = usePasskeyOptions('proof', passkeyAvailable && supported && usingPasskey && !proof.passkey);
  const { busy, error, setError, run } = useSubmit();
  const expiresAt = usingPasskey && proof.passkey ? proof.expiresAt : undefined;
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(
      () => {
        change({ passkey: '' });
        setError('验证已过期，请重新验证。');
      },
      Math.max(0, Date.parse(expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [expiresAt, change, setError]);
  return (
    <>
      {passkeyAvailable && supported && (
        <div className="web-proof-choice">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => change(usingPasskey ? { password: '' } : { passkey: '' })}
          >
            {usingPasskey ? '改用服务凭据验证' : '改用通行密钥验证'}
          </button>
          {usingPasskey &&
            (proof.passkey ? (
              <>
                <p role="status">已通过通行密钥验证</p>
                <button type="button" className="button" onClick={() => change({ passkey: '' })}>
                  重新验证
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="button"
                  disabled={busy || (!options && !optionsError)}
                  onClick={() => {
                    if (!options) {
                      refresh();
                      return;
                    }
                    void run(async (signal) => {
                      try {
                        const value = await proveWithPasskey(options, signal);
                        signal.throwIfAborted();
                        change(value);
                      } finally {
                        refresh();
                      }
                    });
                  }}
                >
                  {busy
                    ? '等待验证…'
                    : optionsError
                      ? '重新准备验证'
                      : options
                        ? '验证通行密钥'
                        : '正在准备验证…'}
                </button>
                {(error || optionsError) && (
                  <p className="error" role="alert">
                    {error || optionsError}
                  </p>
                )}
              </>
            ))}
        </div>
      )}
      {!usingPasskey && (
        <>
          <label>
            服务凭据
            <input
              type="password"
              autoComplete="current-password"
              required
              value={proof.password}
              onChange={(event) => change({ ...proof, password: event.target.value })}
            />
          </label>
          {totp && (
            <label>
              当前验证器动态码
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={proof.code ?? ''}
                onChange={(event) => change({ ...proof, code: event.target.value })}
              />
            </label>
          )}
        </>
      )}
    </>
  );
}
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
      cancelPasskey();
    },
    [],
  );
  async function run(task: (signal: AbortSignal) => Promise<void>) {
    if (pending.current && !pending.current.signal.aborted) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    try {
      await task(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) setError(passkeyError(error));
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return { busy, error, setError, run };
}
export function DialogForm({
  title,
  busy,
  error,
  submit,
  submitLabel,
  close,
  children,
}: {
  title: string;
  busy: boolean;
  error: string;
  submit: () => void;
  submitLabel?: string;
  close: () => void;
  children: ReactNode;
}) {
  return (
    <Modal
      title={title}
      onClose={() => {
        if (!busy) close();
      }}
    >
      <form
        className="web-settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) submit();
        }}
      >
        <fieldset disabled={busy}>{children}</fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {submitLabel ?? (busy ? '正在保存…' : '确认')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
