import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWebAuthStore, SESSION_LIFETIME_MS } from '../electron/web-auth.cjs';

function storage(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ccdt-web-auth-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'auth.json');
}

test('browser authorization persists hashed credentials and an absolute 30-day expiry', (t) => {
  const filePath = storage(t);
  let time = Date.UTC(2026, 0, 1);
  const now = () => time;
  const auth = createWebAuthStore({ filePath, now });
  const issued = auth.issue(undefined, 'Firefox · Linux');
  const [metadata] = auth.list();
  assert.match(metadata.id, /^[a-f0-9]{32}$/);
  assert.notEqual(metadata.id, issued.id);
  assert.equal(auth.get(metadata.id), null);
  assert.deepEqual(metadata, {
    id: metadata.id,
    label: 'Firefox · Linux',
    createdAt: time,
    expiresAt: time + SESSION_LIFETIME_MS,
  });
  assert.equal(readFileSync(filePath, 'utf8').includes(issued.id), false);
  metadata.expiresAt = 0;
  assert.equal(auth.get(issued.id).expiresAt, issued.expiresAt);

  const reopened = createWebAuthStore({ filePath, now });
  assert.equal(reopened.token, auth.token);
  time = issued.expiresAt - 1;
  assert.equal(reopened.get(issued.id).expiresAt, issued.expiresAt);
  assert.equal(reopened.list().length, 1);
  time++;
  assert.equal(reopened.get(issued.id), null);
  assert.deepEqual(reopened.list(), []);
  assert.equal(reopened.accepts(auth.token), true);
});

test('individual revocation, logout and pairing reset invalidate only the intended grants', () => {
  const auth = createWebAuthStore();
  const first = auth.issue(undefined, 'Chrome · Windows');
  const second = auth.issue(undefined, 'Safari · iOS');
  const managementId = auth.get(first.id).id;
  let changes = 0;
  const unsubscribe = auth.subscribe(() => changes++);
  auth.revokeSession(managementId);
  assert.equal(auth.get(first.id), null);
  assert.ok(auth.get(second.id));
  assert.equal(changes, 1);
  auth.revokeSession(managementId);
  assert.equal(changes, 1);
  assert.throws(() => auth.revokeSession(second.id), /Invalid browser session/);
  auth.revoke(second.id);
  assert.equal(auth.get(second.id), null);
  const third = auth.issue();
  const previousToken = auth.token;
  auth.reset();
  assert.equal(auth.accepts(previousToken), false);
  assert.equal(auth.get(third.id), null);
  assert.deepEqual(auth.list(), []);
  unsubscribe();
});

test('re-pairing replaces a browser grant and expired grants do not exhaust the limit', () => {
  let time = Date.UTC(2026, 0, 1);
  const auth = createWebAuthStore({ now: () => time });
  const first = auth.issue();
  const replacement = auth.issue(first.id);
  assert.equal(auth.get(first.id), null);
  assert.ok(auth.get(replacement.id));
  for (let index = 1; index < 32; index++) auth.issue();
  assert.throws(() => auth.issue(), { status: 429 });
  time += SESSION_LIFETIME_MS;
  const next = auth.issue();
  assert.ok(auth.get(next.id));
  assert.equal(auth.list().length, 1);
});

test('idle expiry notifies listeners at the deadline, including timer ranges over 24 days', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.UTC(2026, 0, 1) });
  const auth = createWebAuthStore();
  const issued = auth.issue();
  const expired = [];
  auth.subscribe(() => {
    if (!auth.get(issued.id)) expired.push(issued.id);
  });
  t.mock.timers.tick(2 ** 31 - 1);
  assert.deepEqual(expired, []);
  t.mock.timers.tick(SESSION_LIFETIME_MS - (2 ** 31 - 1));
  assert.deepEqual(expired, [issued.id]);
});

test('the earlier indefinite format keeps its pairing code but requires browsers to re-pair', (t) => {
  const filePath = storage(t);
  const token = 'pairing-code-for-storage-tests';
  const oldId = 'a'.repeat(64);
  const hash = createHash('sha256').update(oldId).digest('hex');
  writeFileSync(
    filePath,
    JSON.stringify({
      version: 2,
      kind: 'private-file',
      payload: JSON.stringify({ token, sessions: { [hash]: true } }),
    }),
  );
  const auth = createWebAuthStore({ filePath });
  assert.equal(auth.token, token);
  assert.equal(auth.get(oldId), null);
  assert.deepEqual(auth.list(), []);
  assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).version, 3);
});

test('malformed saved grants are preserved and failed writes do not revoke valid grants', (t) => {
  const filePath = storage(t);
  const auth = createWebAuthStore({ filePath });
  const issued = auth.issue();
  const failing = createWebAuthStore({
    filePath,
    save: () => {
      throw new Error('Disk write failed.');
    },
  });
  assert.throws(() => failing.revokeSession(failing.get(issued.id).id), /Disk write failed/);
  assert.ok(failing.get(issued.id));
  const envelope = JSON.parse(readFileSync(filePath, 'utf8'));
  const state = JSON.parse(envelope.payload);
  Object.values(state.sessions)[0].expiresAt++;
  envelope.payload = JSON.stringify(state);
  const damaged = JSON.stringify(envelope);
  writeFileSync(filePath, damaged);
  assert.throws(() => createWebAuthStore({ filePath }), /原文件已保留/);
  assert.equal(readFileSync(filePath, 'utf8'), damaged);
});
