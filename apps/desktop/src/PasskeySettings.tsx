import { useEffect, useRef, useState } from 'react';
import type { PasskeyRegistration, WebProof, WebSettingsState } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { loadPasskeyRegistration, registerPasskey, resolveWebProof } from './passkey.ts';
import { DialogForm, ProofFields, message, useSubmit } from './WebSettingsForm.tsx';

export function PasskeyDialog({
  client,
  browser,
  values,
  close,
  changed,
}: {
  client: ProxyClient;
  browser: boolean;
  values: WebSettingsState;
  close: () => void;
  changed: (values: WebSettingsState) => void;
}) {
  const [name, setName] = useState('日常使用');
  const [proof, setProof] = useState<WebProof>({ password: '' });
  const [registration, setRegistration] = useState<PasskeyRegistration | null>(null);
  const [created, setCreated] = useState(false);
  const { busy, error, setError, run } = useSubmit();
  const active = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (active.current)
        void client
          .fetch({ type: 'web.passkeys.cancel', registrationId: active.current })
          .catch(() => {});
    };
  }, [client]);
  async function complete() {
    const result = await client.fetch({ type: 'web.settings.get' });
    if (!mounted.current) return;
    active.current = null;
    changed(result.values);
    close();
  }
  useEffect(() => {
    if (browser || !registration || registration.status !== 'pending') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      try {
        const value = await client.fetch({
          type: 'web.passkeys.status',
          registrationId: registration!.registrationId,
        });
        if (cancelled) return;
        if (value.status === 'complete') {
          active.current = null;
          setCreated(true);
          setRegistration(value);
          await complete();
          return;
        }
        if (value.status === 'expired') {
          active.current = null;
          setRegistration(value);
          return;
        }
        setError('');
      } catch (error) {
        if (cancelled) return;
        setError(message(error));
      }
      if (!cancelled) timer = setTimeout(() => void check(), 1500);
    }
    timer = setTimeout(() => void check(), 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [registration?.registrationId, registration?.status, browser, client]);
  const expired = registration?.status === 'expired';
  async function open(url: string) {
    if (!window.desktop) throw new Error('请从桌面客户端发起浏览器设置。');
    await window.desktop.openWeb(url);
  }
  const submit = () =>
    run(async (signal) => {
      if (created) {
        await complete();
        return;
      }
      if (registration?.status === 'pending' && !browser && registration.url) {
        await open(registration.url);
        return;
      }
      if (active.current) {
        await client.fetch({ type: 'web.passkeys.cancel', registrationId: active.current });
        active.current = null;
        signal.throwIfAborted();
      }
      const value = await client.fetch({
        type: 'web.passkeys.start',
        name: name.trim(),
        ...(browser ? { proof: await resolveWebProof(proof, signal) } : {}),
      });
      if (signal.aborted) {
        void client
          .fetch({ type: 'web.passkeys.cancel', registrationId: value.registrationId })
          .catch(() => {});
        return;
      }
      active.current = value.registrationId;
      setRegistration(value);
      if (!value.url) throw new Error('注册地址未就绪，请重新设置。');
      if (browser) {
        const url = new URL(value.url);
        if (url.origin !== location.origin)
          throw new Error('Web 对外地址已变化，请从新的服务端地址重新登录。');
        const grant = new URLSearchParams(url.hash.slice(1)).get('passkey-register');
        if (!grant) throw new Error('注册授权不完整，请重新设置。');
        const options = await loadPasskeyRegistration(grant, signal);
        await registerPasskey(options, signal);
        signal.throwIfAborted();
        active.current = null;
        setCreated(true);
        await complete();
      } else await open(value.url);
    });
  return (
    <DialogForm
      title="添加通行密钥"
      busy={busy}
      error={error}
      close={close}
      submit={() => void submit()}
      submitLabel={
        created
          ? busy
            ? '正在读取…'
            : '重新读取'
          : busy
            ? '等待验证…'
            : expired
              ? '重新设置'
              : registration && !browser
                ? '重新打开浏览器'
                : browser
                  ? '创建通行密钥'
                  : '前往浏览器设置'
      }
    >
      {created ? (
        <p role="status">通行密钥已创建。{busy ? '正在读取最新设置…' : '请重新读取最新设置。'}</p>
      ) : !registration || expired || browser ? (
        <>
          <label>
            名称
            <input
              value={name}
              maxLength={80}
              required
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <p className="muted">用于登录 {values.domain} 的 Web 工作台。</p>
          {browser && (
            <ProofFields
              proof={proof}
              change={setProof}
              totp={values.totpEnabled}
              passkeyAvailable={values.passkeys.some((key) => key.available)}
            />
          )}
          {expired && <p role="status">本次设置已过期，请重新开始。</p>}
        </>
      ) : (
        <p role="status">等待浏览器完成“{name}”的设置。完成后会自动更新。</p>
      )}
    </DialogForm>
  );
}

export function RenamePasskeyDialog({
  client,
  values,
  browser,
  id,
  close,
  changed,
}: {
  client: ProxyClient;
  values: WebSettingsState;
  browser: boolean;
  id: string;
  close: () => void;
  changed: (values: WebSettingsState) => void;
}) {
  const [name, setName] = useState(values.passkeys.find((key) => key.id === id)?.name ?? '');
  const [proof, setProof] = useState<WebProof>({ password: '' });
  const { busy, error, run } = useSubmit();
  return (
    <DialogForm
      title="重命名通行密钥"
      busy={busy}
      error={error}
      close={close}
      submit={() =>
        void run(async (signal) => {
          const result = await client.fetch({
            type: 'web.passkeys.rename',
            passkeyId: id,
            name: name.trim(),
            ...(browser ? { proof: await resolveWebProof(proof, signal) } : {}),
          });
          signal.throwIfAborted();
          changed(result.values);
          close();
        })
      }
    >
      <label>
        名称
        <input
          value={name}
          maxLength={80}
          required
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {browser && (
        <ProofFields
          proof={proof}
          change={setProof}
          totp={values.totpEnabled}
          passkeyAvailable={values.passkeyAvailable && values.passkeys.some((key) => key.available)}
        />
      )}
    </DialogForm>
  );
}
