import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdmission } from '../src/admission.ts';

test('OpenAI can fill only its half, and Claude still starts', async () => {
  const admission = createAdmission(4);
  await admission.admit('openai').ready;
  await admission.admit('openai').ready;
  assert.equal(admission.running('openai'), 2);
  await admission.admit('claude').ready;
  assert.equal(admission.running('claude'), 1);
  const waiting = admission.admit('openai');
  let started = false;
  void waiting.ready.then(() => {
    started = true;
  });
  await admission.admit('claude').ready;
  assert.equal(admission.running('claude'), 2);
  assert.equal(started, false);
  admission.release('openai');
  await waiting.ready;
  assert.equal(started, true);
});

test('one slot is kept for Claude when both backends are enabled', () => {
  const admission = createAdmission(1);
  assert.throws(
    () => admission.admit('openai'),
    (error: { code?: string; message?: string }) =>
      error.code === 'capacity' && /只够 Claude/.test(error.message ?? ''),
  );
});

test('two waiting backends take turns', async () => {
  const admission = createAdmission(4);
  const order: string[] = [];
  const tickets = [
    admission.admit('claude'),
    admission.admit('openai'),
    admission.admit('claude'),
    admission.admit('openai'),
  ];
  for (const [ticket, name] of [
    [tickets[0], 'c'],
    [tickets[1], 'o'],
    [tickets[2], 'c'],
    [tickets[3], 'o'],
  ] as const)
    void ticket.ready.then(() => order.push(name));
  await Promise.all(tickets.map((ticket) => ticket.ready));
  assert.deepEqual(order, ['c', 'o', 'c', 'o']);
});

test('a full waiting line is refused by name', async () => {
  const admission = createAdmission(2);
  await admission.admit('openai').ready;
  const queued = admission.admit('openai');
  void queued.ready.catch(() => {});
  assert.throws(
    () => admission.admit('openai'),
    (error: { message?: string }) => /OpenAI/.test(error.message ?? ''),
  );
  await admission.admit('claude').ready;
  assert.equal(admission.running('claude'), 1);
  queued.cancel();
});
