import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { saveWebUpload } from '../electron/web-files.cjs';

const maximum = 20 * 1024 * 1024;
async function storage(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ccdt-web-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('valid 4 MiB and 20 MiB attachments round-trip without exhausting the validation stack', async (t) => {
  const root = await storage(t);
  for (const size of [4 * 1024 * 1024, maximum]) {
    const bytes = Buffer.alloc(size, 0xa5);
    const target = await saveWebUpload(root, `${size}.bin`, bytes.toString('base64'));
    assert.deepEqual(await readFile(target), bytes);
  }
});

test('the file size limit checks decoded bytes as well as encoded length', async (t) => {
  const root = await storage(t);
  // One byte over has the same encoded length as the limit; four bytes over exceeds both.
  for (const size of [maximum + 1, maximum + 4])
    await assert.rejects(
      saveWebUpload(root, 'large.bin', Buffer.alloc(size).toString('base64')),
      /最多 20 MB/,
    );
  assert.deepEqual(await readdir(root), []);
});

test('only canonical Base64 is accepted, including its length, alphabet and padding bits', async (t) => {
  const root = await storage(t);
  const invalid = [
    'A',
    'AA',
    'AAA',
    'AA===',
    'A===',
    '====',
    'AA=A',
    '=AAA',
    'AA==AAAA',
    'AA?=',
    'AA-_',
    'AA\n=',
    'AAA\n',
    'AAé=',
    'AB==',
    'AAB=',
    null,
    1234,
  ];
  for (const encoded of invalid)
    await assert.rejects(saveWebUpload(root, 'invalid.bin', encoded), /附件格式错误/);
  assert.deepEqual(await readdir(root), []);
  for (const encoded of ['', 'AA==', 'AAA=', 'AAAA', '+/8=']) {
    const target = await saveWebUpload(root, 'valid.bin', encoded);
    assert.equal((await readFile(target)).toString('base64'), encoded);
  }
});

test('queued uploads enforce the shared quota and a rejection does not poison later writes', async (t) => {
  const root = await storage(t);
  const encoded = Buffer.from('four').toString('base64');
  const results = await Promise.allSettled([
    saveWebUpload(root, 'first.txt', encoded, 6),
    saveWebUpload(root, 'second.txt', encoded, 6),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /Web 附件已达/);
  assert.equal((await readdir(root)).length, 1);
  await unlink(results[0].value);
  const next = await saveWebUpload(root, 'retry.txt', encoded, 6);
  assert.equal(await readFile(next, 'utf8'), 'four');
});

test('a filesystem failure leaves the upload queue usable', async (t) => {
  const directory = await storage(t);
  const blocked = join(directory, 'file-not-directory');
  await writeFile(blocked, 'keep');
  await assert.rejects(saveWebUpload(blocked, 'blocked.txt', 'AA=='));
  assert.equal(await readFile(blocked, 'utf8'), 'keep');
  const target = await saveWebUpload(join(directory, 'uploads'), 'next.txt', 'AA==');
  assert.deepEqual(await readFile(target), Buffer.from([0]));
});
