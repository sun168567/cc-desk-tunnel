import { webLoginStateSchema } from '@cc-desk-tunnel/protocol';
import type { WebProof } from '@cc-desk-tunnel/protocol';

// The server redirects an entry without its trailing slash before serving the application.
export function browserEndpoint(name: string) {
  return new URL(`api/${name}`, new URL('./', location.href));
}
export function browserSocket() {
  const url = browserEndpoint('ws');
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
export async function browserRequest(name: string, body?: unknown, signal?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(browserEndpoint(name), {
      method: body === undefined ? 'GET' : 'POST',
      mode: 'same-origin',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    });
    // A refusal from a proxy or the entry itself may have no JSON body at all.
    const value: unknown = await response.json().catch(() => undefined);
    if (!response.ok || value === undefined) {
      const message =
        value && typeof value === 'object' && 'error' in value
          ? String(value.error)
          : '请求失败，请重试。';
      throw new Error(message);
    }
    return value;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('连接超时，请重试。');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
export const browserSession = async () =>
  webLoginStateSchema.parse(await browserRequest('session'));
export const browserLogin = async (proof: Extract<WebProof, { password: string }>) =>
  webLoginStateSchema.parse(await browserRequest('login', proof));
export const browserLogout = async () => {
  await browserRequest('logout', {});
};
// What the user does on the page keeps the browser's login; the service hears of it at most once a minute.
// Reading counts too, while updates pushed to an unattended page do not.
export function watchActivity(tell: () => boolean) {
  const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
  let last = 0;
  const note = () => {
    if (Date.now() - last >= 60_000 && tell()) last = Date.now();
  };
  for (const type of events) window.addEventListener(type, note, { capture: true, passive: true });
  return () => {
    for (const type of events) window.removeEventListener(type, note, { capture: true });
  };
}
