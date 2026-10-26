import { useEffect, useState } from 'react';
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from '@simplewebauthn/browser';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { webLoginStateSchema } from '@cc-desk-tunnel/protocol';
import type { WebProof } from '@cc-desk-tunnel/protocol';
import { z } from 'zod';
import { browserRequest } from './browser-api.ts';

export function passkeySupportError() {
  if (!window.isSecureContext) return '通行密钥需要可信的 HTTPS 访问地址。';
  if (!browserSupportsWebAuthn()) return '当前浏览器不支持通行密钥，请更换支持 WebAuthn 的浏览器。';
  return undefined;
}
export const cancelPasskey = () => WebAuthnAbortService.cancelCeremony();
export function passkeyError(error: unknown) {
  if (error instanceof Error && ['NotAllowedError', 'AbortError'].includes(error.name))
    return '验证未完成或已取消，请重新操作。';
  if (error instanceof Error && error.name === 'InvalidStateError')
    return '此认证器已保存通行密钥，请选择其他认证器。';
  if (error instanceof Error && ['ConstraintError', 'NotSupportedError'].includes(error.name))
    return '此认证器不支持本次通行密钥操作，请尝试其他设备或密码管理器。';
  if (error instanceof Error && error.name === 'SecurityError')
    return '请确认当前域名和 HTTPS 证书有效，再重新验证。';
  return error instanceof Error ? error.message : '通行密钥验证失败，请重试。';
}

// The server creates these options; the WebAuthn library converts them and the server verifies the response.
const authenticationOptions = z.object({
  challengeId: z.uuid(),
  expiresAt: z.iso.datetime(),
  options: z.custom<PublicKeyCredentialRequestOptionsJSON>(
    (value) => !!value && typeof value === 'object' && 'challenge' in value,
  ),
});
const registrationOptions = z.object({
  challengeId: z.uuid(),
  options: z.custom<PublicKeyCredentialCreationOptionsJSON>(
    (value) => !!value && typeof value === 'object' && 'challenge' in value,
  ),
  name: z.string(),
  expiresAt: z.iso.datetime(),
});
export type PasskeyRegistrationOptions = z.infer<typeof registrationOptions>;
type AuthenticationOptions = z.infer<typeof authenticationOptions>;
// Expiry belongs to the form; only the credential proof is sent with a command.
export type ProofInput = WebProof & { expiresAt?: string };

export async function releasePasskey(kind: 'register' | 'login' | 'proof', challengeId: string) {
  // If the connection is lost, the server's original expiry still bounds the reservation.
  await browserRequest(`passkey/${kind}/cancel`, { challengeId }).catch(() => {});
}

async function ceremony<T>(expiresAt: string, start: () => Promise<T>) {
  const remaining = Date.parse(expiresAt) - Date.now();
  if (remaining <= 0) throw new Error('本次验证已过期，请重新准备。');
  const timer = setTimeout(cancelPasskey, remaining);
  try {
    return await start();
  } finally {
    clearTimeout(timer);
  }
}

// Fetch options before the user presses the authentication button, so get() runs in that click.
export function usePasskeyOptions(kind: 'login' | 'proof', enabled: boolean) {
  const [options, setOptions] = useState<AuthenticationOptions | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setOptions(null);
    setError('');
    if (!enabled) return;
    let disposed = false;
    let pending: AuthenticationOptions | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Read even a late response, so an unmounted view can release its server reservation.
    void browserRequest(`passkey/${kind}/options`, {})
      .then(async (value) => {
        const next = authenticationOptions.parse(value);
        if (disposed) return releasePasskey(kind, next.challengeId);
        pending = next;
        const expire = () => {
          setOptions(null);
          setError('本次验证已过期，请重新准备。');
          void releasePasskey(kind, next.challengeId);
          pending = undefined;
        };
        const remaining = Date.parse(next.expiresAt) - Date.now();
        if (remaining <= 0) return expire();
        setOptions(next);
        timer = setTimeout(expire, remaining);
      })
      .catch((error: unknown) => {
        if (!disposed) setError(passkeyError(error));
      });
    return () => {
      disposed = true;
      clearTimeout(timer);
      if (pending) void releasePasskey(kind, pending.challengeId);
    };
  }, [kind, enabled, attempt]);
  return { options, error, refresh: () => setAttempt((value) => value + 1) };
}
export async function authenticatePasskey(
  kind: 'login' | 'proof',
  result: AuthenticationOptions,
  signal?: AbortSignal,
) {
  try {
    signal?.throwIfAborted();
    const unsupported = passkeySupportError();
    if (unsupported) throw new Error(unsupported);
    const response = await ceremony(result.expiresAt, () =>
      startAuthentication({ optionsJSON: result.options }),
    );
    signal?.throwIfAborted();
    return await browserRequest(
      `passkey/${kind}/verify`,
      { challengeId: result.challengeId, response },
      signal,
    );
  } catch (error) {
    await releasePasskey(kind, result.challengeId);
    throw error;
  }
}
export async function loginWithPasskey(result: AuthenticationOptions, signal?: AbortSignal) {
  return webLoginStateSchema.parse(await authenticatePasskey('login', result, signal));
}
export async function proveWithPasskey(result: AuthenticationOptions, signal?: AbortSignal) {
  const value = await authenticatePasskey('proof', result, signal);
  const { proof, expiresAt } = z
    .object({ proof: z.string().min(1), expiresAt: z.iso.datetime() })
    .parse(value);
  return { passkey: proof, expiresAt };
}
export function confirmedWebProof(proof: ProofInput): WebProof {
  if ('passkey' in proof) {
    if (!proof.passkey) throw new Error('请先完成通行密钥验证。');
    if (!proof.expiresAt || Date.parse(proof.expiresAt) <= Date.now())
      throw new Error('验证已过期，请重新验证。');
    return { passkey: proof.passkey };
  }
  return proof;
}
export async function preparePasskey(name: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const options = registrationOptions.parse(
    await browserRequest('passkey/register/options', { name }),
  );
  if (signal?.aborted) {
    await releasePasskey('register', options.challengeId);
    signal.throwIfAborted();
  }
  return options;
}
export async function registerPasskey(result: PasskeyRegistrationOptions, signal?: AbortSignal) {
  try {
    signal?.throwIfAborted();
    const unsupported = passkeySupportError();
    if (unsupported) throw new Error(unsupported);
    const response = await ceremony(result.expiresAt, () =>
      startRegistration({ optionsJSON: result.options }),
    );
    signal?.throwIfAborted();
    return z
      .object({ registered: z.literal(true), id: z.uuid() })
      .parse(
        await browserRequest(
          'passkey/register/verify',
          { challengeId: result.challengeId, response },
          signal,
        ),
      );
  } catch (error) {
    await releasePasskey('register', result.challengeId);
    throw error;
  }
}
