import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const methods = new Set([
  'client:state',
  'client:request',
  'client:fetch',
  'client:select',
  'client:load-earlier',
  'client:terminal',
  'client:clear-error',
]);

// This transport owns browser sockets only. Operations run on the existing desktop client; it never
// connects to the proxy service, changes its subscriptions, or takes ownership of its execution channel.
export function createWebControl(invoke) {
  const views = new Map();
  function send(view, value) {
    if (view.socket.readyState !== WebSocket.OPEN) return;
    try {
      view.socket.send(JSON.stringify(value));
    } catch {
      view.socket.terminate();
    }
  }
  return {
    attach(socket) {
      if (views.size >= 16) return socket.close(1013, 'Too many browser pages');
      const id = randomUUID();
      const view = { socket, requests: new Map(), pending: 0 };
      views.set(id, view);
      socket.on('error', () => socket.terminate());
      socket.once('close', () => {
        views.delete(id);
        // Keep detach after already-queued state requests, which register the desktop-side view.
        void Promise.resolve()
          .then(() => invoke('client:detach', [], id))
          .catch(() => {});
      });
      socket.on('message', (raw, binary) => {
        let request;
        try {
          if (binary) throw new Error();
          request = JSON.parse(raw.toString('utf8'));
          if (
            !request ||
            typeof request.id !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,120}$/.test(request.id) ||
            !methods.has(request.method) ||
            !Array.isArray(request.args)
          )
            throw new Error();
        } catch {
          socket.close(1008, 'Invalid browser operation');
          return;
        }
        const text = JSON.stringify([request.method, request.args]);
        const old = view.requests.get(request.id);
        if (old) {
          if (old.text !== text) socket.close(1008, 'Request ID conflict');
          else if (old.response) send(view, old.response);
          return;
        }
        if (view.pending >= 64) return socket.close(1013, 'Too many pending requests');
        const entry = { text, response: null };
        view.requests.set(request.id, entry);
        view.pending++;
        void Promise.resolve()
          .then(() => invoke(request.method, request.args, id))
          .then(
            (result) => ({ type: 'response', id: request.id, ok: true, result }),
            (error) => ({
              type: 'response',
              id: request.id,
              ok: false,
              error: error instanceof Error ? error.message : '桌面客户端上的操作失败。',
            }),
          )
          .then((response) => {
            view.pending--;
            entry.response = response;
            send(view, response);
            for (const [key, remembered] of view.requests) {
              if (view.requests.size <= 512) break;
              if (remembered.response) view.requests.delete(key);
            }
          });
      });
    },
    publish({ viewId, message }) {
      if (!message || typeof message !== 'object') return;
      if (viewId) {
        const view = views.get(viewId);
        if (view) send(view, message);
      } else for (const view of views.values()) send(view, message);
    },
  };
}
