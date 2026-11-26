import { phraseSchema, webLoginStateSchema } from '@cc-desk-tunnel/protocol';
import type { WebProof } from '@cc-desk-tunnel/protocol';
import { say, t } from './i18n.ts';

// The server redirects an entry without its trailing slash before serving the application.
export function browserEndpoint(name: string) {
  return new URL(`api/${name}`, new URL('./', location.href));
}
export function browserSocket() {
  const url = browserEndpoint('ws');
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
async function request(name: string, body?: unknown) {
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
      signal: controller.signal,
    });
    // A refusal from a proxy or the entry itself may have no JSON body at all.
    const value: unknown = await response.json().catch(() => undefined);
    if (!response.ok || value === undefined) {
      // The service says why in a phrase, with its text beside it.
      const said = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
      const phrase = phraseSchema.safeParse(said.phrase);
      const message = phrase.success
        ? say(phrase.data, typeof said.error === 'string' ? said.error : undefined)
        : typeof said.error === 'string'
          ? said.error
          : t('connection:browserRequestFailed');
      throw new Error(message);
    }
    return value;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(t('connection:browserTimeout'));
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
export const browserSession = async () => webLoginStateSchema.parse(await request('session'));
export const browserLogin = async (proof: WebProof) =>
  webLoginStateSchema.parse(await request('login', proof));
export const browserLogout = async () => {
  await request('logout', {});
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
