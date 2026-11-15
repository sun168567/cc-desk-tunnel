const { Worker } = require('node:worker_threads');
const path = require('node:path');

class HistoryCache {
  constructor(directory, historyModule = require.resolve('@cc-desk-tunnel/protocol/history')) {
    this.worker = new Worker(path.join(__dirname, 'history-cache-worker.cjs'), {
      workerData: { directory, historyModule },
    });
    this.pending = new Map();
    this.next = 0;
    this.generations = new Map();
    this.worker.on('message', ({ id, result, error }) => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      error ? pending.reject(new Error(error)) : pending.resolve(result);
    });
    this.worker.on('error', (error) => {
      this.failure = error;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
    this.worker.on('exit', (code) => {
      this.failure ??= new Error(`缓存进程已退出（${code}）。`);
      for (const pending of this.pending.values()) pending.reject(this.failure);
      this.pending.clear();
    });
  }
  async request(message) {
    if (this.failure) throw this.failure;
    const key = message.url ? new URL(message.url).href : '';
    let generation = this.generations.get(key) ?? 0;
    if (message.type === 'save' && message.generation !== generation) return;
    if (message.type === 'clear') {
      generation++;
      this.generations.set(key, generation);
    }
    const result = await new Promise((resolve, reject) => {
      const id = ++this.next;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, message });
    });
    return message.type === 'read' || message.type === 'list' || message.type === 'clear'
      ? { value: result, generation }
      : result;
  }
  async close() {
    try {
      await this.request({ type: 'close' });
    } finally {
      await this.worker.terminate();
    }
  }
}
module.exports = { HistoryCache };
