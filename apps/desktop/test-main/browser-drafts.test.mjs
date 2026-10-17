import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBrowserDrafts } from '../src/browser-drafts.ts';

function storage(values = {}) {
  const entries = new Map(Object.entries(values));
  return {
    get length() {
      return entries.size;
    },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
  };
}

test('tabs preserve independent drafts across reloads without replacing another session backup', () => {
  const backup = storage(),
    firstView = storage(),
    secondView = storage();
  const first = createBrowserDrafts(backup, firstView);
  const second = createBrowserDrafts(backup, secondView);
  assert.deepEqual(first.load(), {});
  assert.deepEqual(second.load(), {});
  first.save({ one: 'first tab unsent work' });
  second.save({ two: 'second tab unsent work' });
  assert.deepEqual(createBrowserDrafts(backup, firstView).load(), { one: 'first tab unsent work' });
  assert.deepEqual(createBrowserDrafts(backup, secondView).load(), {
    two: 'second tab unsent work',
  });
  assert.deepEqual(createBrowserDrafts(backup, storage()).load(), {
    one: 'first tab unsent work',
    two: 'second tab unsent work',
  });
});

test('the same session stays independent in existing tabs; new tabs recover its latest edit', () => {
  const backup = storage(),
    firstView = storage(),
    secondView = storage();
  const first = createBrowserDrafts(backup, firstView),
    second = createBrowserDrafts(backup, secondView);
  first.load();
  second.load();
  first.save({ one: 'first' });
  second.save({ one: 'second' });
  const reloaded = createBrowserDrafts(backup, firstView);
  assert.deepEqual(reloaded.load(), { one: 'first' });
  reloaded.save({ one: 'first' });
  assert.deepEqual(createBrowserDrafts(backup, secondView).load(), { one: 'second' });
  assert.deepEqual(createBrowserDrafts(backup, storage()).load(), { one: 'second' });
  // Sending an older view's draft must not clear another tab's newer recovery copy.
  reloaded.save({});
  assert.deepEqual(createBrowserDrafts(backup, storage()).load(), { one: 'second' });
  second.save({});
  assert.deepEqual(createBrowserDrafts(backup, storage()).load(), {});
});

test('a duplicated tab starts with a snapshot but later edits and reloads remain independent', () => {
  const backup = storage(),
    firstView = storage();
  const first = createBrowserDrafts(backup, firstView);
  first.load();
  first.save({ one: 'original' });
  const duplicateView = storage({ 'remote-drafts': firstView.getItem('remote-drafts') });
  const duplicate = createBrowserDrafts(backup, duplicateView);
  assert.deepEqual(duplicate.load(), { one: 'original' });
  duplicate.save({ one: 'duplicate edit' });
  assert.deepEqual(createBrowserDrafts(backup, firstView).load(), { one: 'original' });
  assert.deepEqual(createBrowserDrafts(backup, duplicateView).load(), { one: 'duplicate edit' });
});

test('legacy backups migrate once, keep newer values and preserve unrelated preferences', () => {
  const backup = storage({
    'remote-drafts': JSON.stringify({ one: 'legacy one', two: 'legacy two', empty: '', bad: 3 }),
    'remote-draft:two': 'newer',
    'proxy-prefs': 'unchanged',
  });
  const store = createBrowserDrafts(backup, storage());
  assert.deepEqual(store.load(), { one: 'legacy one', two: 'newer' });
  assert.equal(backup.getItem('remote-drafts'), null);
  assert.equal(backup.getItem('proxy-prefs'), 'unchanged');
  store.save({ two: 'newer' });
  assert.deepEqual(createBrowserDrafts(backup, storage()).load(), { two: 'newer' });
});

test('full storage does not hide saved drafts or resurrect cleared legacy text', () => {
  const backup = storage({ 'remote-drafts': JSON.stringify({ one: 'legacy', two: 'another' }) });
  const write = backup.setItem;
  // Both keys and values consume quota: even a new empty tombstone cannot fit.
  let limit = 'remote-drafts'.length + backup.getItem('remote-drafts').length;
  backup.setItem = (key, value) => {
    let size = key.length + value.length;
    for (let index = 0; index < backup.length; index++) {
      const saved = backup.key(index);
      if (saved !== key) size += saved.length + backup.getItem(saved).length;
    }
    if (size > limit) throw new Error('QuotaExceededError');
    write(key, value);
  };
  const store = createBrowserDrafts(backup, storage());
  assert.deepEqual(store.load(), { one: 'legacy', two: 'another' });
  assert.notEqual(backup.getItem('remote-drafts'), null);
  store.save({ two: 'another' });
  assert.deepEqual(createBrowserDrafts(backup, storage()).load(), { two: 'another' });
  limit = Infinity;
  assert.deepEqual(createBrowserDrafts(backup, storage()).load(), { two: 'another' });
  assert.equal(backup.getItem('remote-drafts'), null);

  const fullView = storage({ 'remote-drafts': JSON.stringify({ one: 'tab draft' }) });
  fullView.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  assert.deepEqual(createBrowserDrafts(backup, fullView).load(), { one: 'tab draft' });
});
