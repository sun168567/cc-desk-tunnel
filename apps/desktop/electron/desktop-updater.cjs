const { mkdir, mkdtemp, readdir, rm, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { failure } = require('./failure.cjs');

// Both installers keep using their download after this process exits. A later attempt clears week-old
// private directories, including partial downloads left by a crash.
async function downloadDirectory(temporaryDirectory) {
  const root = join(temporaryDirectory, 'cc-desk-tunnel-updates');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const oldest = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^download-[a-zA-Z0-9]{6}$/.test(entry.name)) continue;
    const previous = join(root, entry.name);
    const info = await stat(previous).catch(() => null);
    if (info && info.mtimeMs < oldest)
      await rm(previous, { recursive: true, force: true }).catch(() => {});
  }
  return mkdtemp(join(root, 'download-'));
}

async function closeOthers(installer, report, signal) {
  const instances = await installer.instances();
  signal.throwIfAborted();
  if (!instances.length) return;
  report({ phase: 'closing' });
  const deadline = Date.now() + 15000;
  await Promise.all(instances.map((instance) => installer.requestQuit(instance)));
  while ((await installer.instances()).length) {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw failure('desktop:upgrade.othersOpen');
    await delay(250);
  }
}

// A release-page request names the version. A service-cache request uses the installer the connection
// advertised. The platform chooses the artifact, how to prepare it, and how to hand it off at the end.
function createDesktopUpdater({
  installer,
  packaged,
  fetch,
  finish,
  temporaryDirectory = tmpdir(),
}) {
  let active = null;

  async function install(version, { connected, bridge, report }) {
    if (!packaged) throw failure('desktop:upgrade.fromSource');
    if (!installer) throw failure('desktop:upgrade.unsupported');
    if (active) throw failure('desktop:upgrade.already');
    const release = installer.releaseOptions(version, { connected, bridge });
    if (!release && !bridge) throw failure('desktop:upgrade.connectFirst');
    const source = release ? 'github' : 'service';
    const controller = (active = new AbortController());
    const signal = controller.signal;
    let directory;
    let prepared;
    let lastProgress = 0;
    const tell = (step) => {
      if (step.phase === 'downloading') {
        if (Date.now() - lastProgress < 400 && step.received < step.size) return;
        lastProgress = Date.now();
      }
      report({ source, ...step });
    };
    const progress = (received, size) => tell({ phase: 'downloading', received, size });

    try {
      directory = await downloadDirectory(temporaryDirectory);
      tell({ phase: 'connecting' });
      const { downloadRelease } = await import('./release-download.mjs');
      const file = release
        ? await downloadRelease(fetch, version, directory, {
            ...release,
            progress,
            report: tell,
            signal,
          })
        : await bridge.downloadInstaller(directory, { progress, signal });
      signal.throwIfAborted();

      prepared = await installer.prepare({ file, version, directory, signal, report: tell });
      signal.throwIfAborted();
      await closeOthers(installer, tell, signal);
      signal.throwIfAborted();
      tell({ phase: 'installing' });
      await prepared.install();
    } catch (error) {
      try {
        await prepared?.cancel?.();
      } catch {}
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      if (error?.cancelled || (signal.aborted && error === signal.reason))
        return { cancelled: true };
      throw error;
    } finally {
      active = null;
    }
    finish();
    return {};
  }

  return { install, cancel: () => active?.abort() };
}

// Platform-specific setup happens once. The window and IPC handlers use the same updater throughout
// the life of the application.
function applicationUpdater({
  app,
  net,
  Notification,
  dialog,
  profile,
  otherConnections,
  programArguments,
  t,
}) {
  const factories = {
    win32: require('./windows-update.cjs').windowsInstaller,
    darwin: require('./macos-update.cjs').macInstaller,
  };
  const installer =
    app.isPackaged &&
    factories[process.platform]?.({
      app,
      dialog,
      profile,
      otherConnections,
      programArguments,
      t,
    });
  return {
    ...createDesktopUpdater({
      installer,
      packaged: app.isPackaged,
      fetch: (url, options) => net.fetch(url, options),
      finish() {
        try {
          if (Notification.isSupported())
            new Notification({
              title: t('desktop:upgrade.title'),
              body: t('desktop:upgrade.body'),
              icon: join(__dirname, 'icon.png'),
            }).show();
        } finally {
          app.quit();
        }
      },
    }),
    onAppReady: installer?.onAppReady,
    onRendererReady: installer?.onRendererReady,
    onWindowReady: installer?.onWindowReady,
  };
}
module.exports = { createDesktopUpdater, applicationUpdater };
