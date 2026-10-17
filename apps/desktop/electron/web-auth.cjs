const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { dirname, join } = require('node:path');

const hash = (value) => createHash('sha256').update(value).digest('hex');
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TIMER_MS = 2 ** 31 - 1;

// Keep both auth state and successful listener preferences atomic: a failed replacement leaves the old file.
function atomicPrivateWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file) && lstatSync(file).isSymbolicLink())
    throw new Error('Private storage is a symlink.');
  const temp = join(dirname(file), `.remote-${randomBytes(12).toString('hex')}.tmp`);
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}

// Authentication cookies are stored only as SHA-256 hashes; listed management IDs cannot authenticate.
// An available OS secret store encrypts the pairing code and metadata together. The fallback is a private file.
function createWebAuthStore({
  filePath,
  safeStorage,
  token,
  save = atomicPrivateWrite,
  now = () => Date.now(),
} = {}) {
  const listeners = new Set();
  let expiryTimer;
  const encrypted = () =>
    safeStorage?.isEncryptionAvailable() === true &&
    safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  function persist(next) {
    if (!filePath) return;
    const plain = JSON.stringify(next);
    const envelope = encrypted()
      ? {
          version: 3,
          kind: 'safe-storage',
          payload: safeStorage.encryptString(plain).toString('base64'),
        }
      : { version: 3, kind: 'private-file', payload: plain };
    save(filePath, JSON.stringify(envelope));
  }
  let state;
  if (filePath && existsSync(filePath)) {
    try {
      if (lstatSync(filePath).isSymbolicLink() || lstatSync(filePath).size > 65536)
        throw new Error();
      const envelope = JSON.parse(readFileSync(filePath, 'utf8'));
      if (![2, 3].includes(envelope.version) || typeof envelope.payload !== 'string')
        throw new Error();
      if (envelope.kind === 'safe-storage') {
        if (!encrypted()) throw new Error();
        state = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.payload, 'base64')));
      } else if (envelope.kind === 'private-file') state = JSON.parse(envelope.payload);
      else throw new Error();
      if (
        !state ||
        typeof state.token !== 'string' ||
        state.token.length < 24 ||
        state.token.length > 256 ||
        !state.sessions ||
        typeof state.sessions !== 'object' ||
        Array.isArray(state.sessions) ||
        Object.keys(state.sessions).length > 32
      )
        throw new Error();
      const entries = Object.entries(state.sessions);
      if (
        entries.some(
          ([id, value]) =>
            !/^[a-f0-9]{64}$/.test(id) ||
            (envelope.version === 2
              ? value !== true
              : !value ||
                typeof value !== 'object' ||
                Array.isArray(value) ||
                typeof value.id !== 'string' ||
                !/^[a-f0-9]{32}$/.test(value.id) ||
                typeof value.label !== 'string' ||
                value.label.length < 1 ||
                value.label.length > 80 ||
                /[\u0000-\u001f\u007f]/.test(value.label) ||
                !Number.isSafeInteger(value.createdAt) ||
                value.createdAt < 0 ||
                !Number.isSafeInteger(value.expiresAt) ||
                value.expiresAt !== value.createdAt + SESSION_LIFETIME_MS),
        ) ||
        (envelope.version === 3 &&
          new Set(entries.map(([, value]) => value.id)).size !== entries.length)
      )
        throw new Error();
      // Unreleased indefinite sessions cannot acquire a trustworthy creation date. Keep the
      // pairing code, but require those browsers to pair again under the finite lifetime.
      if (envelope.version === 2) {
        state = { token: state.token, sessions: {} };
        persist(state);
      }
      chmodSync(filePath, 0o600);
    } catch {
      throw new Error('远程配对数据读取失败；原文件已保留。');
    }
  } else {
    const initial = token ?? randomBytes(24).toString('base64url');
    if (typeof initial !== 'string' || initial.length < 24 || initial.length > 256)
      throw new Error('The pairing token must contain 24–256 characters.');
    state = { token: initial, sessions: {} };
    persist(state);
  }
  function notify() {
    for (const listener of listeners) {
      try {
        listener();
      } catch {}
    }
  }
  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    const time = now();
    const next = Math.min(
      ...Object.values(state.sessions)
        .map((session) => session.expiresAt)
        .filter((expiresAt) => expiresAt > time),
    );
    if (!Number.isFinite(next)) return;
    expiryTimer = setTimeout(
      () => {
        notify();
        scheduleExpiry();
      },
      // A 30-day lifetime exceeds Node's largest timeout; recheck before scheduling the remainder.
      Math.min(next - time, MAX_TIMER_MS),
    );
    expiryTimer.unref();
  }
  function commit(next) {
    persist(next);
    state = next;
    scheduleExpiry();
    notify();
  }
  scheduleExpiry();
  return {
    get token() {
      return state.token;
    },
    accepts(value) {
      return (
        typeof value === 'string' &&
        timingSafeEqual(Buffer.from(hash(value), 'hex'), Buffer.from(hash(state.token), 'hex'))
      );
    },
    get(id) {
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return null;
      const session = state.sessions[hash(id)];
      return session && session.expiresAt > now() ? { ...session } : null;
    },
    list() {
      return Object.values(state.sessions)
        .filter((session) => session.expiresAt > now())
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((session) => ({ ...session }));
    },
    issue(previousId, label = '浏览器') {
      if (
        typeof label !== 'string' ||
        !label.trim() ||
        label.length > 80 ||
        /[\u0000-\u001f\u007f]/.test(label)
      )
        throw new Error('Invalid browser label.');
      const createdAt = now();
      const sessions = Object.fromEntries(
        Object.entries(state.sessions).filter(([, session]) => session.expiresAt > createdAt),
      );
      if (typeof previousId === 'string') delete sessions[hash(previousId)];
      if (Object.keys(sessions).length >= 32)
        throw Object.assign(new Error('Too many paired browsers.'), { status: 429 });
      const id = randomBytes(32).toString('hex');
      const session = {
        id: randomBytes(16).toString('hex'),
        label: label.trim(),
        createdAt,
        expiresAt: createdAt + SESSION_LIFETIME_MS,
      };
      sessions[hash(id)] = session;
      commit({ ...state, sessions });
      return { id, expiresAt: session.expiresAt };
    },
    revoke(id) {
      if (typeof id !== 'string' || !Object.hasOwn(state.sessions, hash(id))) return;
      const sessions = { ...state.sessions };
      delete sessions[hash(id)];
      commit({ ...state, sessions });
    },
    revokeSession(id) {
      if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id))
        throw new Error('Invalid browser session.');
      const entry = Object.entries(state.sessions).find(([, session]) => session.id === id);
      if (!entry) return;
      const sessions = { ...state.sessions };
      delete sessions[entry[0]];
      commit({ ...state, sessions });
    },
    reset() {
      commit({ token: randomBytes(24).toString('base64url'), sessions: {} });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

module.exports = { createWebAuthStore, atomicPrivateWrite, SESSION_LIFETIME_MS };
