const { randomUUID } = require('node:crypto');

// Bounded main-to-renderer requests, used only while Web is enabled. The sender that received a request
// must answer it; closing a browser never grants it a way to invoke arbitrary desktop IPC.
function createWebRequests({ window, timeout = 30_000 }) {
  const pending = new Map();
  const views = new Map();
  let detachTimer;
  function detachClosedViews() {
    clearTimeout(detachTimer);
    detachTimer = undefined;
    for (const [viewId, view] of views) {
      if (view.sender.isDestroyed()) {
        views.delete(viewId);
        continue;
      }
      if (!view.closing) continue;
      try {
        // The same sender/channel preserves ordering after the accepted state request. Cleanup is
        // idempotent and needs no business request slot or response; unsolicited replies are ignored.
        view.sender.send('remote:request', {
          id: randomUUID(),
          method: 'client:detach',
          args: [],
          viewId,
        });
        views.delete(viewId);
      } catch {
        // Keep a failed notification in the bounded view registry, rather than lose a live view.
      }
    }
    if ([...views.values()].some((view) => view.closing)) {
      detachTimer = setTimeout(detachClosedViews, 250);
      detachTimer.unref();
    }
  }
  return {
    invoke(method, args, viewId) {
      if (method === 'client:detach') {
        const view = views.get(viewId);
        if (view) {
          view.closing = true;
          detachClosedViews();
        }
        return Promise.resolve(null);
      }
      const sender = window()?.webContents;
      if (!sender || sender.isDestroyed()) return Promise.reject(new Error('桌面窗口尚未就绪。'));
      if (pending.size >= 128) return Promise.reject(new Error('等待桌面处理的请求过多。'));
      let registered = false;
      if (method === 'client:state') {
        detachClosedViews();
        const view = views.get(viewId);
        if (!viewId || (view && (view.sender !== sender || view.closing)))
          return Promise.reject(new Error('浏览器页面已失效，请重新连接。'));
        if (!view) {
          if (views.size >= 16) return Promise.reject(new Error('浏览器页面过多。'));
          views.set(viewId, { sender, closing: false });
          registered = true;
        }
      }
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('桌面操作结果尚未确认；请查看当前状态，操作未自动重发。'));
        }, timeout);
        pending.set(id, { sender, resolve, reject, timer });
        try {
          sender.send('remote:request', { id, method, args, viewId });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          if (registered) views.delete(viewId);
          reject(error);
        }
      });
    },
    reply(sender, response) {
      const entry = pending.get(response?.id);
      if (!entry || entry.sender !== sender) return;
      clearTimeout(entry.timer);
      pending.delete(response.id);
      if (response.ok === true) entry.resolve(response.result);
      else entry.reject(new Error(String(response.error || '桌面操作失败。')));
    },
    cancel() {
      clearTimeout(detachTimer);
      detachTimer = undefined;
      views.clear();
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Web 入口已关闭；已发送的操作未自动重发。'));
      }
      pending.clear();
    },
  };
}

module.exports = { createWebRequests };
