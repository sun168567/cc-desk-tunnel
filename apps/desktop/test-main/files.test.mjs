import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createFiles } from '../electron/files.mjs';
import { FileService, sftpPath } from '../../server/src/files.ts';

// The service's side of the file connection, with OpenSSH's SFTP server as it finds one (Git's on Windows), joined
// to the client by a pair of streams instead of the service's WebSocket.
const sftpServer = [
  '/usr/lib/openssh/sftp-server',
  '/usr/libexec/openssh/sftp-server',
  '/usr/libexec/sftp-server',
  'C:/Program Files/Git/usr/lib/ssh/sftp-server.exe',
].find((path) => existsSync(path));
const skip = sftpServer ? false : 'no OpenSSH SFTP server on this machine';

async function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'cc-files-'));
  const service = new FileService(join(base, 'data'), {
    sftpServer: [sftpServer],
    landlock: false,
  });
  mkdirSync(join(base, 'data'));
  await service.start();
  let opened = 0;
  const files = createFiles({
    open: async () => {
      opened++;
      const up = new PassThrough();
      const down = new PassThrough();
      service.serve(Duplex.from({ readable: up, writable: down }), () => service.ownServer());
      return Duplex.from({ readable: down, writable: up });
    },
  });
  t.after(() => {
    files.close();
    service.close();
    rmSync(base, { recursive: true, force: true });
  });
  const local = join(base, 'local');
  const remote = join(base, 'data', 'native', 'root');
  mkdirSync(local);
  mkdirSync(remote, { recursive: true });
  return { files, local, remote, at: (file) => sftpPath(file), opened: () => opened };
}

test(
  'lists, reads, makes, renames and removes files on the service and here alike',
  { skip, timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    writeFileSync(join(f.remote, 'notes.md'), '# 笔记\n');
    mkdirSync(join(f.remote, 'sub'));
    writeFileSync(join(f.remote, 'sub', 'inner.txt'), 'x');
    for (const [target, directory] of [
      ['server', f.at(f.remote)],
      ['local', f.remote],
    ]) {
      const entries = await f.files.list(target, directory);
      assert.deepEqual(
        entries.map(({ name, kind }) => [name, kind]).sort(),
        [
          ['notes.md', 'file'],
          ['sub', 'directory'],
        ],
        target,
      );
    }
    const read = await f.files.read('server', f.at(join(f.remote, 'notes.md')));
    assert.equal(read.bytes.toString(), '# 笔记\n');
    assert.equal(read.truncated, false);
    const part = await f.files.read('server', f.at(join(f.remote, 'notes.md')), 3);
    assert.deepEqual([part.bytes.length, part.size, part.truncated], [3, 9, true]);
    await f.files.mkdir('server', f.at(join(f.remote, 'made')));
    await f.files.rename('server', f.at(join(f.remote, 'made')), f.at(join(f.remote, 'renamed')));
    assert.deepEqual(await f.files.exists('server', f.at(f.remote), ['renamed', 'made']), [
      true,
      false,
    ]);
    // A directory goes with what is in it.
    await f.files.remove('server', [f.at(join(f.remote, 'sub')), f.at(join(f.remote, 'renamed'))]);
    assert.deepEqual(
      (await f.files.list('server', f.at(f.remote))).map((entry) => entry.name),
      ['notes.md'],
    );
    await assert.rejects(f.files.read('server', f.at(join(f.remote, 'gone.txt'))), /不存在/);
    // The panel's sessions share one connection.
    assert.equal(f.opened(), 1);
  },
);

test(
  'copies between this computer and the service, folders whole, resuming a copy that stopped',
  { skip, timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const big = Buffer.alloc(3 * 1024 * 1024);
    for (let index = 0; index < big.length; index++) big[index] = (index * 31) & 255;
    mkdirSync(join(f.local, 'dataset', 'deep'), { recursive: true });
    writeFileSync(join(f.local, 'dataset', 'big.bin'), big);
    writeFileSync(join(f.local, 'dataset', 'deep', 'small.txt'), 'small');
    const reports = [];
    const up = await f.files.transfer({
      from: { target: 'local', paths: [join(f.local, 'dataset')] },
      to: { target: 'server', dir: f.at(f.remote) },
      progress: (report) => reports.push(report),
    });
    assert.deepEqual(up, { files: 2, bytes: big.length + 5 });
    assert.deepEqual(readFileSync(join(f.remote, 'dataset', 'big.bin')), big);
    assert.equal(readFileSync(join(f.remote, 'dataset', 'deep', 'small.txt'), 'utf8'), 'small');
    assert.equal(reports.at(-1).done, reports.at(-1).total);
    // Back down, after the first megabyte had come before: only the rest is fetched.
    mkdirSync(join(f.local, 'back'));
    writeFileSync(join(f.local, 'back', 'big.bin'), big.subarray(0, 1024 * 1024));
    const resumed = [];
    await f.files.transfer({
      from: { target: 'server', paths: [f.at(join(f.remote, 'dataset', 'big.bin'))] },
      to: { target: 'local', dir: join(f.local, 'back') },
      conflict: 'resume',
      progress: (report) => resumed.push(report),
    });
    assert.deepEqual(readFileSync(join(f.local, 'back', 'big.bin')), big);
    assert.ok(resumed[0].done >= 1024 * 1024);
    // A file there already is left alone when asked to skip it.
    writeFileSync(join(f.local, 'back', 'big.bin'), 'mine');
    await f.files.transfer({
      from: { target: 'server', paths: [f.at(join(f.remote, 'dataset', 'big.bin'))] },
      to: { target: 'local', dir: join(f.local, 'back') },
      conflict: 'skip',
    });
    assert.equal(readFileSync(join(f.local, 'back', 'big.bin'), 'utf8'), 'mine');
    // Between two places that are not this computer, through a file here.
    mkdirSync(join(f.remote, 'copy'));
    await f.files.transfer({
      from: { target: 'server', paths: [f.at(join(f.remote, 'dataset', 'big.bin'))] },
      to: { target: 'server', dir: f.at(join(f.remote, 'copy')) },
    });
    assert.deepEqual(readFileSync(join(f.remote, 'copy', 'big.bin')), big);
  },
);

// A copy that does not end when stopped would otherwise hold the run until the job's own limit.
test(
  'a copy stopped part way ends at once and keeps what it wrote',
  { skip, timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    writeFileSync(join(f.local, 'huge.bin'), Buffer.alloc(40 * 1024 * 1024, 1));
    const controller = new AbortController();
    const copy = f.files.transfer({
      from: { target: 'local', paths: [join(f.local, 'huge.bin')] },
      to: { target: 'server', dir: f.at(f.remote) },
      progress: ({ done }) => done > 1024 * 1024 && controller.abort(),
      signal: controller.signal,
    });
    await assert.rejects(copy, /已取消/);
    const kept = statSync(join(f.remote, 'huge.bin')).size;
    assert.ok(kept > 0 && kept < 40 * 1024 * 1024, `kept ${kept}`);
    // The panel's own session is still there.
    assert.equal((await f.files.list('server', f.at(f.remote))).length, 1);
  },
);
