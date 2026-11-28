import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import updater from '../electron/macos-update.cjs';

const exec = promisify(execFile);
const mac = { skip: process.platform !== 'darwin', timeout: 120_000 };

// A small signed native application in a disposable directory. Its two builds either acknowledge launch or
// exit without acknowledging it. Neither test needs to run, stop or change the installed desktop client.
async function fixture(t, { legacy = false } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ccdt mac-update-'));
  const stop = join(root, 'stop-fixture');
  const running = join(root, 'fixture-running');
  t.after(async () => {
    await writeFile(stop, 'stop');
    if (existsSync(running)) await waitFor(() => !existsSync(running), root);
    await rm(root, { recursive: true, force: true });
  });
  const source = join(root, 'probe.m');
  const bundle = join(root, 'CC Desk Tunnel.app');
  const payload = join(root, 'payload');
  const update = join(payload, 'CC Desk Tunnel.app');
  const directory = join(root, 'download');
  await mkdir(directory);
  await writeFile(
    source,
    `#import <AppKit/AppKit.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  const char *prefix = "--ccdt-update-receipt=";
  const char *receipt = NULL;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--fail-test-start")) return 1;
    if (!strncmp(argv[i], prefix, strlen(prefix))) receipt = argv[i] + strlen(prefix);
  }
  if (!receipt) return 0;
  FILE *marker = fopen(${JSON.stringify(running)}, "w");
  if (!marker) return 2;
  fclose(marker);
  [NSApplication sharedApplication];
  [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
  if (${legacy ? '0' : '1'}) {
    dispatch_async(dispatch_get_main_queue(), ^{
      FILE *f = fopen(receipt, "w");
      if (f) { fputs("9.8.7", f); fclose(f); }
    });
  }
  const double deadline = CFAbsoluteTimeGetCurrent() + 90;
  [NSTimer scheduledTimerWithTimeInterval:0.2 repeats:YES block:^(NSTimer *timer) {
    if (!access(${JSON.stringify(stop)}, F_OK) || CFAbsoluteTimeGetCurrent() > deadline) [NSApp terminate:nil];
  }];
  [[NSNotificationCenter defaultCenter] addObserverForName:NSApplicationWillTerminateNotification
    object:nil queue:nil usingBlock:^(NSNotification *note) { unlink(${JSON.stringify(running)}); }];
  [NSApp run];
  return 0;
}`,
  );
  for (const [app, version] of [
    [bundle, '9.8.6'],
    [update, '9.8.7'],
  ]) {
    const contents = join(app, 'Contents');
    await mkdir(join(contents, 'MacOS'), { recursive: true });
    const plist = `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>CFBundleIdentifier</key><string>io.github.ccdesktunnel.desktop</string>
      <key>CFBundleExecutable</key><string>Probe</string><key>CFBundlePackageType</key><string>APPL</string>
      <key>CFBundleVersion</key><string>${version}</string><key>CFBundleShortVersionString</key><string>${version}</string>
      ${legacy ? '' : '<key>CCDTUpdateReceipt</key><true/>'}<key>LSUIElement</key><true/>
    </dict></plist>`;
    await writeFile(join(contents, 'Info.plist'), plist);
    await exec('/usr/bin/clang', [
      source,
      '-framework',
      'AppKit',
      '-o',
      join(contents, 'MacOS/Probe'),
    ]);
    await exec('/usr/bin/codesign', ['--force', '--sign', '-', app]);
  }
  const installer = join(directory, 'test.dmg');
  await exec('/usr/bin/hdiutil', [
    'create',
    '-quiet',
    '-fs',
    'HFS+',
    '-format',
    'UDZO',
    '-srcfolder',
    payload,
    installer,
  ]);
  const options = {
    application: bundle,
    expectedVersion: '9.8.7',
    arch: process.arch,
    directory,
    installer,
  };
  return {
    options,
    prepare: () => updater.prepareMacUpdate(options),
    getVersion: async () =>
      (
        await exec('/usr/bin/plutil', [
          '-extract',
          'CFBundleShortVersionString',
          'raw',
          '-o',
          '-',
          join(bundle, 'Contents/Info.plist'),
        ])
      ).stdout.trim(),
  };
}

async function waitFor(predicate, directory) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await predicate()) return;
    await delay(150);
  }
  const log = await readFile(join(directory, 'mac-install.log'), 'utf8').catch(() => 'no log');
  assert.fail('update helper did not finish: ' + log);
}

test(
  'a verified Mac update exchanges the app after handoff and a failed launch restores the old bundle',
  mac,
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      updater.prepareMacUpdate({ ...f.options, expectedVersion: '0.0.1' }),
      (error) => error.phrase?.key === 'desktop:upgrade.macInvalidBundle',
    );
    assert.equal(await f.getVersion(), '9.8.6');
    const failed = await f.prepare();
    await assert.rejects(
      f.prepare(),
      (error) => error.phrase?.key === 'desktop:upgrade.macUpdateBusy',
    );
    const notice = join(f.options.directory, 'failure');
    // The launcher PID is already gone, as it is once the client has completed app.quit().
    await failed.launch({
      parentPid: 2147483647,
      args: ['--fail-test-start'],
      waitSeconds: 6,
      failureFile: notice,
    });
    await waitFor(() => existsSync(notice), f.options.directory);
    assert.match(await readFile(notice, 'utf8'), /previous version has been restored/);
    await waitFor(() => !existsSync(failed.staged), f.options.directory);
    assert.equal(await f.getVersion(), '9.8.6');
    const clean = await fixture(t);
    const success = await clean.prepare();
    await success.launch({ parentPid: 2147483647, waitSeconds: 40 });
    await waitFor(() => !existsSync(success.staged), clean.options.directory);
    assert.equal(await clean.getVersion(), '9.8.7');
    assert.match(
      await readFile(join(clean.options.directory, 'mac-install.log'), 'utf8'),
      /Renderer acknowledged 9\.8\.7/,
    );
  },
);

test(
  'an older Mac release without the renderer receipt must reach the Launch Services run loop and keeps the old app',
  mac,
  async (t) => {
    const f = await fixture(t, { legacy: true });
    const update = await f.prepare();
    await update.launch({ parentPid: 2147483647, waitSeconds: 40 });
    await waitFor(() => !existsSync(update.staged), f.options.directory);
    assert.equal(await f.getVersion(), '9.8.7');
    assert.equal(
      (
        await exec('/usr/bin/plutil', [
          '-extract',
          'CFBundleShortVersionString',
          'raw',
          '-o',
          '-',
          join(f.options.directory, 'Previous.app', 'Contents/Info.plist'),
        ])
      ).stdout.trim(),
      '9.8.6',
    );
    assert.match(
      await readFile(join(f.options.directory, 'mac-install.log'), 'utf8'),
      /Startup confirmed by Launch Services/,
    );
  },
);
