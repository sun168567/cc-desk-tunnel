import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
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
  assert.throws(() => mac.releaseOptions('9.8.6', {}), {
    message: 'desktop:download.badVersion',
  });
  assert.throws(() => mac.releaseOptions(undefined, {}), {
    message: 'desktop:download.badVersion',
  });

  for (const [platform, name] of [
    [windows, 'CC-Desk-Tunnel-Setup-9.8.7-x64.exe'],
    [mac, `CC-Desk-Tunnel-9.8.7-mac-${process.arch}.dmg`],
  ]) {
    const steps = [];
    let otherOpen = true;
    const selected = platform.releaseOptions(version, { bridge });
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

test('downloads a week old are cleared, those of earlier clients included, and nothing else', async (t) => {
  const temporaryDirectory = await rootFor(t);
  const root = join(temporaryDirectory, 'cc-desk-tunnel-updates');
  const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const old = [
    join(root, 'download-aaaaaa'),
    join(temporaryDirectory, 'cc-desk-tunnel-update-bbbbbb'),
  ];
  const kept = [
    join(root, 'download-cccccc'),
    join(temporaryDirectory, 'cc-desk-tunnel-update-dddddd'),
    join(temporaryDirectory, 'something-else'),
  ];
  for (const directory of [...old, ...kept]) await mkdir(directory, { recursive: true });
  for (const directory of [...old, kept[2]]) await utimes(directory, weekAgo, weekAgo);
  let used;
  const updater = updaterModule.createDesktopUpdater({
    packaged: true,
    temporaryDirectory,
    installer: {
      releaseOptions: () => null,
      instances: () => [],
      prepare: () => ({ install() {} }),
    },
    finish() {},
  });
  await updater.install(undefined, {
    bridge: {
      downloadInstaller(where) {
        used = where;
        return join(where, 'installer');
      },
    },
    report() {},
  });
  for (const directory of old) assert.equal(existsSync(directory), false, directory);
  for (const directory of [...kept, used]) assert.equal(existsSync(directory), true, directory);
});
