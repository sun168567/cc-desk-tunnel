import { useEffect, useState } from 'react';
import type { WebSettingsState } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { confirmedWebProof, preparePasskey, registerPasskey, releasePasskey } from './passkey.ts';
import type { PasskeyRegistrationOptions, ProofInput } from './passkey.ts';
import { DialogForm, ProofFields, useSubmit } from './WebSettingsForm.tsx';

export function PasskeyDialog({
  client,
  values,
  close,
  changed,
}: {
  client: ProxyClient;
  values: WebSettingsState;
  close: () => void;
  changed: (values: WebSettingsState) => void;
}) {
  const [name, setName] = useState('日常使用');
  const [registration, setRegistration] = useState<PasskeyRegistrationOptions | null>(null);
  const [created, setCreated] = useState(false);
  const { busy, error, run } = useSubmit();
  useEffect(
    () => () => {
      if (registration) void releasePasskey('register', registration.challengeId);
    },
    [registration],
  );
  const submit = () =>
    run(async (signal) => {
      if (!registration && !created) {
        const options = await preparePasskey(name.trim(), signal);
        signal.throwIfAborted();
        setRegistration(options);
        return;
      }
      if (!created) {
        try {
          await registerPasskey(registration!, signal);
          signal.throwIfAborted();
          setCreated(true);
        } finally {
          if (!signal.aborted) setRegistration(null);
        }
      }
      const result = await client.fetch({ type: 'web.settings.get' });
      signal.throwIfAborted();
      changed(result.values);
      close();
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
          : registration
            ? busy
              ? '正在创建…'
              : '创建通行密钥'
            : busy
              ? '正在准备…'
              : '下一步'
      }
    >
      {created ? (
        <p role="status">通行密钥已创建。请重新读取最新设置。</p>
      ) : registration ? (
        <>
          <p>
            为 {values.domain} 创建“{registration.name}”。
          </p>
          <p className="muted">点击后，在浏览器或系统提示中选择保存位置。</p>
        </>
      ) : (
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
        </>
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
  const [proof, setProof] = useState<ProofInput>({ password: '' });
  const { busy, error, run } = useSubmit();
  return (
    <DialogForm
      title="重命名通行密钥"
      busy={busy}
      error={error}
      close={close}
      submit={() =>
        void run(async (signal) => {
          const result = await client
            .fetch({
              type: 'web.passkeys.rename',
              passkeyId: id,
              name: name.trim(),
              ...(browser ? { proof: confirmedWebProof(proof) } : {}),
            })
            .finally(() => {
              if (!signal.aborted && 'passkey' in proof) setProof({ passkey: '' });
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
          passkeyAvailable={values.passkeys.some((key) => key.available)}
        />
      )}
    </DialogForm>
  );
}
