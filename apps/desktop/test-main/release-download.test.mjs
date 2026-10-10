import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { downloadRelease } from '../electron/release-download.mjs';

const installer = Buffer.from(Array.from({ length: 20_000 }, (_, index) => index % 251));
const sha256 = createHash('sha256').update(installer).digest('hex');
const name = 'CC-Desk-Tunnel-Setup-9.8.7-x64.exe';
// A stand-in for the release page. `serve` answers the installer request; the manifest is `manifest`.
async function page(
  t,
  serve,
  manifest = { version: '9.8.7', files: [{ name, size: installer.length, sha256 }] },
) {
  const ranges = [];
  const server = createServer((request, response) => {
    if (request.url === '/v9.8.7/release.json') response.end(JSON.stringify(manifest));
    else if (request.url === `/v9.8.7/${name}`) {
      ranges.push(request.headers.range);
      serve(request, response, ranges.length);
    } else response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = mkdtempSync(join(tmpdir(), 'release-download-'));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const options = (extra = {}) => ({
    page: `http://127.0.0.1:${server.address().port}`,
    pace: { stretch: 2000, stall: 60, attempts: 3 },
    ...extra,
  });
  return { directory, ranges, options };
}
const start = (request) => Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? '')?.[1] ?? 0);

test('the installer is taken from the release page, across connections that go quiet, and checked against the manifest', async (t) => {
  // Every connection sends 6,000 bytes and then goes quiet without closing; the second sends nothing.
  const f = await page(t, (request, response, count) => {
    const from = start(request);
    response.writeHead(from ? 206 : 200);
    response.flushHeaders();
    if (count === 2) return;
    response.write(installer.subarray(from, from + 6000));
    if (from + 6000 >= installer.length) response.end();
  });
  const seen = [];
  const target = await downloadRelease(
    fetch,
    '9.8.7',
    f.directory,
    f.options({
      announced: { version: '9.8.7', sha256 },
      progress: (received, size) => seen.push([received, size]),
    }),
  );
  assert.equal(target, join(f.directory, name));
  assert.deepEqual(readFileSync(target), installer);
  assert.deepEqual(f.ranges, [
    undefined,
    'bytes=6000-',
    'bytes=6000-',
    'bytes=12000-',
    'bytes=18000-',
  ]);
  assert.deepEqual(seen.at(-1), [installer.length, installer.length]);
});

test('a host that sends the whole file again instead of continuing still yields the right file', async (t) => {
  const f = await page(t, (_request, response, count) => {
    response.writeHead(200);
    response.flushHeaders();
    if (count === 1) response.write(installer.subarray(0, 5000));
    else response.end(installer);
  });
  assert.deepEqual(
    readFileSync(await downloadRelease(fetch, '9.8.7', f.directory, f.options())),
    installer,
  );
});

test('nothing is kept of a file that is not the announced one, of a download that stops for good, or of a missing release', async (t) => {
  const whole = (_request, response) => response.end(installer);
  const other = await page(t, whole);
  await assert.rejects(
    downloadRelease(
      fetch,
      '9.8.7',
      other.directory,
      other.options({ announced: { version: '9.8.7', sha256: '0'.repeat(64) } }),
    ),
    /不是同一个文件/,
  );
  assert.equal(other.ranges.length, 0);
  const wrong = await page(t, (_request, response) =>
    response.end(Buffer.alloc(installer.length, 1)),
  );
  await assert.rejects(
    downloadRelease(fetch, '9.8.7', wrong.directory, wrong.options()),
    /校验失败/,
  );
  assert.deepEqual(readdirSync(wrong.directory), []);
  const larger = await page(t, (_request, response) =>
    response.end(Buffer.concat([installer, installer])),
  );
  await assert.rejects(
    downloadRelease(fetch, '9.8.7', larger.directory, larger.options()),
    /比发布信息里的大/,
  );
  const silent = await page(t, (_request, response) => response.flushHeaders());
  await assert.rejects(
    downloadRelease(fetch, '9.8.7', silent.directory, silent.options()),
    /下载中断.*0 \/ 20000/,
  );
  assert.equal(silent.ranges.length, 3);
  assert.equal(existsSync(join(silent.directory, name)), false);
  const refused = await page(t, (_request, response) => response.writeHead(403).end());
  await assert.rejects(
    downloadRelease(fetch, '9.8.7', refused.directory, refused.options()),
    /403/,
  );
  assert.equal(refused.ranges.length, 1);
  const absent = await page(t, whole, { version: '9.8.6', files: [] });
  await assert.rejects(
    downloadRelease(fetch, '9.8.7', absent.directory, absent.options()),
    /没有这个版本/,
  );
  await assert.rejects(
    downloadRelease(fetch, '9.8.7', absent.directory, { page: 'http://127.0.0.1:1' }),
    /读取不到/,
  );
  await assert.rejects(
    downloadRelease(fetch, '../9', absent.directory, absent.options()),
    /版本号不正确/,
  );
});
