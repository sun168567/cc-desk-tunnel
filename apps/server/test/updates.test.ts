import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { ServiceUpdate } from '@cc-desk-tunnel/protocol';
import { ServiceUpdates, isNewer, serviceVersion } from '../src/updates.ts';

// A stand-in for the GitHub releases API: one latest release with a manifest and an installer.
async function feed(t: TestContext, version: string, runtime = 1) {
  const installer = Buffer.from(`installer ${version}`);
  const name = `CC-Desk-Tunnel-Setup-${version}-x64.exe`;
  const manifest = {
    version,
    runtime,
    files: [
      {
        name,
        size: installer.length,
        sha256: createHash('sha256').update(installer).digest('hex'),
      },
    ],
  };
  const requests: { url: string; authorization?: string }[] = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url!, authorization: request.headers.authorization });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (/^\/repos\/owner\/name\/releases\/(latest|tags\/v[\d.]+)$/.test(request.url!))
      response.end(
        JSON.stringify({
          assets: [
            { name: 'release.json', url: `${base}/assets/1` },
            { name, url: `${base}/assets/2` },
          ],
        }),
      );
    else if (request.url === '/assets/1') response.end(JSON.stringify(manifest));
    else if (request.url === '/assets/2') response.end(installer);
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-updates-'));
  t.after(() => {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const states: ServiceUpdate[] = [];
  const updates = (options: { runtimeLevel?: number; repository?: string } = {}) => {
    if (options.runtimeLevel) writeFileSync(join(directory, 'level'), `${options.runtimeLevel}\n`);
    return new ServiceUpdates(
      {
        repository: options.repository ?? 'owner/name',
        token: 'read-only-token',
        api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        programDir: options.runtimeLevel ? join(directory, 'program') : undefined,
        runtimeDir: options.runtimeLevel ? directory : undefined,
        clientDir: join(directory, 'client'),
        restart: () => undefined,
      },
      (state) => states.push(state),
    );
  };
  return { directory, name, installer, manifest, requests, states, updates };
}

test('version comparison is numeric', () => {
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('0.2.1', '0.2.10'), false);
});

test('a newer release is installable only where the runtime is recent enough', async (t) => {
  const f = await feed(t, '99.0.0', 2);
  const reported = f.updates();
  await reported.check();
  assert.deepEqual(
    f.states.map((state) => state.state),
    ['checking', 'manual'],
  );
  assert.equal(reported.state.latest, '99.0.0');
  assert.ok(f.requests.every((request) => request.authorization === 'Bearer read-only-token'));
  assert.throws(() => reported.install('99.0.0'));

  const outdated = f.updates({ runtimeLevel: 1 });
  await outdated.check();
  assert.equal(outdated.state.state, 'manual');
  const current = f.updates({ runtimeLevel: 2 });
  await current.check();
  assert.equal(current.state.state, 'available');
  assert.throws(() => current.install('98.0.0'));
});

test('the same or an older release, or an unreachable page, offers nothing', async (t) => {
  const f = await feed(t, serviceVersion());
  const updates = f.updates({ runtimeLevel: 1 });
  await updates.check();
  assert.equal(updates.state.state, 'idle');
  assert.ok(updates.state.checkedAt);
  const missing = f.updates({ repository: 'owner/absent' });
  await missing.check();
  assert.equal(missing.state.state, 'failed');
  assert.match(missing.state.detail!, /404/);
});

test('the installer of the running version is fetched for clients and checked against the manifest', async (t) => {
  const f = await feed(t, serviceVersion());
  const updates = f.updates();
  updates.start();
  t.after(() => updates.stop());
  const target = join(f.directory, 'client', f.name);
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      assert.deepEqual(readFileSync(target), f.installer);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.fail('The installer was not downloaded.');
});

test('an installer download that slows to a halt is continued on new connections, and tried again after the page fails', async (t) => {
  const version = serviceVersion();
  const installer = Buffer.from(Array.from({ length: 20_000 }, (_, index) => index % 251));
  const name = `CC-Desk-Tunnel-Setup-${version}-x64.exe`;
  const manifest = {
    version,
    runtime: 1,
    files: [
      {
        name,
        size: installer.length,
        sha256: createHash('sha256').update(installer).digest('hex'),
      },
    ],
  };
  const ranges: (string | undefined)[] = [];
  let pages = 0;
  const server = createServer((request, response) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (request.url === `/repos/owner/name/releases/tags/v${version}`) {
      // The release page is out of reach the first time it is asked.
      if (++pages === 1) return void response.writeHead(503).end();
      response.end(
        JSON.stringify({
          assets: [
            { name: 'release.json', url: `${base}/assets/1` },
            { name, url: `${base}/assets/2` },
          ],
        }),
      );
    } else if (request.url === '/assets/1') response.end(JSON.stringify(manifest));
    else if (request.url === '/assets/2') {
      ranges.push(request.headers.range);
      const start = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? '')?.[1] ?? 0);
      // The second connection delivers nothing at all; every other one sends 6,000 bytes and then goes quiet
      // without closing.
      response.writeHead(start ? 206 : 200, { 'Content-Type': 'application/octet-stream' });
      response.flushHeaders();
      if (ranges.length !== 2) response.write(installer.subarray(start, start + 6000));
      if (start + 6000 >= installer.length && ranges.length !== 2) response.end();
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-updates-'));
  const updates = new ServiceUpdates(
    {
      repository: 'owner/name',
      api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      clientDir: join(directory, 'client'),
      restart: () => undefined,
      download: { stretch: 2000, stall: 60, attempts: 3, retry: 50 },
    },
    () => undefined,
  );
  t.after(() => {
    updates.stop();
    server.closeAllConnections();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  updates.start();
  const target = join(directory, 'client', name);
  let seen = 0;
  for (let attempt = 0; attempt < 500 && !existsSync(target); attempt++) {
    seen = Math.max(seen, updates.preparing?.received ?? 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(readFileSync(target), installer);
  assert.equal(pages, 2);
  assert.deepEqual(ranges, [
    undefined,
    'bytes=6000-',
    'bytes=6000-',
    'bytes=12000-',
    'bytes=18000-',
  ]);
  // While it was on its way, clients could be told how far it was; nothing is left to tell afterwards.
  assert.ok(seen >= 6000 && seen < installer.length);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(updates.preparing, undefined);
  assert.equal(existsSync(`${target}.part`), false);
});

test('a download whose connections keep delivering nothing is given up, and one that is not the announced file is discarded', async (t) => {
  const f = await feed(t, serviceVersion());
  f.manifest.files[0].sha256 = '0'.repeat(64);
  const updates = f.updates();
  updates.start();
  t.after(() => updates.stop());
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(readdirSync(join(f.directory, 'client')), []);
});
