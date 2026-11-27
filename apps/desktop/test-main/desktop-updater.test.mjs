import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import updaterModule from '../electron/desktop-updater.cjs';
import windowsModule from '../electron/windows-update.cjs';
import macModule from '../electron/macos-update.cjs';

const version = '9.8.7';
const bytes = Buffer.from('update fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');

async function rootFor(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ccdt-updater-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Windows and Mac select their own release assets and share the same verified download and installer handoff', async (t) => {
  const temporaryDirectory = await rootFor(t);
  const windows = windowsModule.windowsInstaller({
    profile: temporaryDirectory,
    otherConnections: () => [],
  });
  const mac = macModule.macInstaller({
    app: {
      getVersion: () => '9.8.6',
      getPath: () => join(temporaryDirectory, 'Contents', 'MacOS', 'client'),
    },
    profile: temporaryDirectory,
  });
  const winOffer = { version, sha256 };
  const bridge = { release: () => winOffer };
  assert.equal(windows.releaseOptions(undefined, { bridge }), null);
  assert.deepEqual(windows.releaseOptions(version, { bridge }), {
    name: 'CC-Desk-Tunnel-Setup-9.8.7-x64.exe',
    announced: winOffer,
  });
  assert.throws(() => mac.releaseOptions(version, { connected: false }), {
    message: 'desktop:upgrade.connectFirst',
  });
  assert.throws(() => mac.releaseOptions('9.8.6', { connected: true }), {
    message: 'desktop:download.badVersion',
  });
  assert.throws(() => mac.releaseOptions(undefined, { connected: true }), {
    message: 'desktop:download.badVersion',
  });

  for (const [platform, name] of [
    [windows, 'CC-Desk-Tunnel-Setup-9.8.7-x64.exe'],
    [mac, `CC-Desk-Tunnel-9.8.7-mac-${process.arch}.dmg`],
  ]) {
    const steps = [];
    let otherOpen = true;
    const selected = platform.releaseOptions(version, { connected: true, bridge });
    assert.equal(selected.name, name);
    if (platform === mac) assert.equal(selected.announced, undefined);
    const installer = {
      ...platform,
      instances: () => (otherOpen ? [123] : []),
      requestQuit(pid) {
        assert.equal(pid, 123);
        otherOpen = false;
      },
      async prepare({ file }) {
        assert.equal(basename(file), name);
        assert.deepEqual(await readFile(file), bytes);
        return {
          install() {
            steps.push('handoff');
          },
        };
      },
    };
    const updater = updaterModule.createDesktopUpdater({
      packaged: true,
      installer,
      temporaryDirectory,
      fetch(url) {
        if (url.endsWith('/release.json'))
          return Response.json({ version, files: [{ name, size: bytes.length, sha256 }] });
        assert.ok(url.endsWith('/' + name));
        return new Response(bytes);
      },
      finish() {
        steps.push('quit');
      },
    });
    assert.deepEqual(
      await updater.install(version, {
        bridge,
        connected: true,
        report(step) {
          assert.equal(step.source, 'github');
          steps.push(step.phase);
        },
      }),
      {},
    );
    assert.deepEqual(steps, [
      'connecting',
      'downloading',
      'verifying',
      'closing',
      'installing',
      'handoff',
      'quit',
    ]);
  }
});

test('a cancelled service download and a failed handoff clean up and allow another install without quitting', async (t) => {
  const temporaryDirectory = await rootFor(t);
  const started = Promise.withResolvers();
  let directory,
    cancels = 0,
    downloads = 0,
    finished = 0;
  const bridge = {
    async downloadInstaller(where, { signal }) {
      directory = where;
      const file = join(where, 'setup.exe');
      await writeFile(file, bytes);
      if (++downloads === 1) {
        started.resolve();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        throw Object.assign(new Error('cancelled'), { cancelled: true });
      }
      return file;
    },
  };
  const installer = {
    releaseOptions: () => null,
    instances: () => [],
    prepare() {
      return {
        install() {
          throw new Error('installer launch failed');
        },
        cancel() {
          cancels++;
        },
      };
    },
  };
  const updater = updaterModule.createDesktopUpdater({
    installer,
    packaged: true,
    temporaryDirectory,
    finish() {
      finished++;
    },
  });
  const request = { bridge, report: (step) => assert.equal(step.source, 'service') };
  const downloading = updater.install(undefined, request);
  await started.promise;
  await assert.rejects(updater.install(undefined, request), { message: 'desktop:upgrade.already' });
  updater.cancel();
  assert.deepEqual(await downloading, { cancelled: true });
  assert.equal(existsSync(directory), false);
  await assert.rejects(updater.install(undefined, request), /installer launch failed/);
  assert.equal(existsSync(directory), false);
  assert.equal(cancels, 1);
  assert.equal(finished, 0);
});

test('cancelling while other instances are being enumerated leaves them running', async (t) => {
  const temporaryDirectory = await rootFor(t);
  const listing = Promise.withResolvers();
  const result = Promise.withResolvers();
  let directory,
    rolledBack = false;
  const updater = updaterModule.createDesktopUpdater({
    packaged: true,
    temporaryDirectory,
    installer: {
      releaseOptions: () => null,
      prepare: () => ({
        install: () => assert.fail('cancelled installation was handed off'),
        cancel: () => {
          rolledBack = true;
        },
      }),
      instances: () => {
        listing.resolve();
        return result.promise;
      },
      requestQuit: () => assert.fail('cancelled update asked a window to quit'),
    },
    finish: () => assert.fail('cancelled update quit the application'),
  });
  const installing = updater.install(undefined, {
    bridge: {
      downloadInstaller(where) {
        directory = where;
        return join(where, 'installer');
      },
    },
    report() {},
  });
  await listing.promise;
  updater.cancel();
  result.resolve([123]);
  assert.deepEqual(await installing, { cancelled: true });
  assert.equal(rolledBack, true);
  assert.equal(existsSync(directory), false);
});
