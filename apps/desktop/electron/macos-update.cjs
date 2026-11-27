const { execFile, spawn } = require('node:child_process');
const { constants, lstatSync, readFileSync, realpathSync, writeFileSync } = require('node:fs');
const connections = require('./connections.cjs');
const {
  access,
  copyFile,
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  rmdir,
  stat,
} = require('node:fs/promises');
const { basename, dirname, isAbsolute, join, resolve } = require('node:path');
const { promisify } = require('node:util');
const { failure } = require('./failure.cjs');

const execute = promisify(execFile);
const bundleId = 'io.github.ccdesktunnel.desktop';
const invalid = () => failure('desktop:upgrade.macInvalidBundle');
const location = () => failure('desktop:upgrade.macInstallLocation');

async function plist(application, key) {
  const { stdout } = await execute('/usr/bin/plutil', [
    '-extract',
    key,
    'raw',
    '-o',
    '-',
    join(application, 'Contents/Info.plist'),
  ]);
  return stdout.trim();
}

function checkCancellation(signal) {
  if (signal?.aborted) throw failure('desktop:download.cancelled', undefined, { cancelled: true });
}

// flock(2) locks the open file description shared by the main process and the detached helper.
// macOS 13 and 14 lack the file-descriptor form of the lockf command.
async function acquireLock(target) {
  const lock = await open(
    target,
    constants.O_RDONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o644,
  );
  try {
    if (!(await lock.stat()).isFile()) throw location();
    await new Promise((resolve, reject) => {
      const locker = spawn(
        '/usr/bin/osascript',
        [
          '-l',
          'JavaScript',
          '-e',
          `ObjC.import('Foundation');
           ObjC.bindFunction('flock', ['int', ['int', 'int']]);
           const LOCK_EX = 2, LOCK_NB = 4;
           if ($.flock(3, LOCK_EX | LOCK_NB) !== 0) throw Error('Cannot acquire update lock');`,
        ],
        { stdio: ['ignore', 'ignore', 'ignore', lock.fd] },
      );
      locker.once('error', reject);
      locker.once('exit', (code) =>
        code === 0 ? resolve() : reject(failure('desktop:upgrade.macUpdateBusy')),
      );
    });
    return lock;
  } catch (error) {
    await lock.close();
    throw error;
  }
}

// The main process quits only after the helper has loaded from outside the installed app, inherited the
// lock, checked the paths and acknowledged over a private pipe. Its diagnostic log also lives outside.
async function startHelper(argv, lock) {
  await new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', argv, {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', lock.fd],
    });
    const handoff = child.stdio[3];
    const deadline = setTimeout(() => {
      child.kill();
      reject(new Error('The update helper did not acknowledge the handoff.'));
    }, 10000);
    handoff.setEncoding('utf8');
    let response = '';
    handoff.on('data', (chunk) => {
      response += chunk;
    });
    const failed = (error) => {
      clearTimeout(deadline);
      reject(error);
    };
    child.once('error', failed);
    handoff.once('error', failed);
    handoff.once('end', () => {
      clearTimeout(deadline);
      child.unref();
      if (response === 'ready\n') resolve();
      else reject(new Error('The update helper could not take over the staged application.'));
    });
  });
}

async function prepareMacUpdate({
  installer,
  application,
  expectedVersion,
  arch,
  directory,
  signal,
}) {
  if (
    process.platform !== 'darwin' ||
    !/^(arm64|x64)$/.test(arch) ||
    typeof expectedVersion !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(expectedVersion)
  )
    throw invalid();
  if (
    !application ||
    !isAbsolute(application) ||
    !application.endsWith('.app') ||
    !isAbsolute(directory) ||
    !isAbsolute(installer)
  )
    throw location();

  let lock, stage;
  try {
    checkCancellation(signal);
    if (!(await lstat(application)).isDirectory()) throw location();
    application = await realpath(application);
    const parent = dirname(application);
    if (
      application.startsWith('/Volumes/') ||
      application.includes('/AppTranslocation/') ||
      /[\r\n]/.test(application) ||
      parent.includes('.app/')
    )
      throw location();
    await access(parent, constants.W_OK | constants.X_OK).catch(() => {
      throw location();
    });
    if ((await plist(application, 'CFBundleIdentifier')) !== bundleId) throw location();

    const original = await stat(application, { bigint: true });
    const prefix = join(parent, '.' + basename(application) + '.ccdt-update');
    lock = await acquireLock(prefix + '.lock');
    checkCancellation(signal);
    stage = await mkdtemp(prefix + '-');
    const staged = join(stage, 'Candidate.app');
    const mount = await mkdtemp(join(directory, 'mount-'));
    let attached = false;
    try {
      await execute(
        '/usr/bin/hdiutil',
        ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, installer],
        { timeout: 120000 },
      );
      attached = true;
      checkCancellation(signal);
      const source = join(await realpath(mount), 'CC Desk Tunnel.app');
      if (!(await lstat(source)).isDirectory() || (await realpath(source)) !== source)
        throw invalid();
      await execute('/usr/bin/ditto', ['--rsrc', '--extattr', source, staged], { signal });
    } finally {
      if (attached)
        await execute('/usr/bin/hdiutil', ['detach', mount], { timeout: 30000 }).catch(() =>
          execute('/usr/bin/hdiutil', ['detach', '-force', mount], { timeout: 30000 }),
        );
      await rmdir(mount).catch(() => {});
    }

    const [id, version, executable] = await Promise.all(
      ['CFBundleIdentifier', 'CFBundleShortVersionString', 'CFBundleExecutable'].map((key) =>
        plist(staged, key),
      ),
    );
    if (
      id !== bundleId ||
      version !== expectedVersion ||
      !executable ||
      executable === '.' ||
      executable === '..' ||
      basename(executable) !== executable ||
      /[\r\n]/.test(executable)
    )
      throw invalid();
    const binary = join(staged, 'Contents/MacOS', executable);
    if ((await realpath(binary)) !== binary) throw invalid();
    const info = await execute('/usr/bin/file', ['-b', binary], {
      env: { ...process.env, LC_ALL: 'C' },
    });
    const architecture = arch === 'arm64' ? /\barm64\b/ : /\bx86_64\b/;
    if (
      !info.stdout.includes('Mach-O') ||
      !info.stdout.includes('executable') ||
      !architecture.test(info.stdout)
    )
      throw invalid();
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged], { signal });
    const receipt = await plist(staged, 'CCDTUpdateReceipt').catch(() => '');
    await copyFile(join(__dirname, 'macos-update.sh'), join(stage, 'install.sh'));
    checkCancellation(signal);

    let handedOff = false;
    return {
      staged,
      async cancel() {
        if (handedOff) return;
        handedOff = true;
        try {
          await rm(stage, { recursive: true, force: true });
        } finally {
          await lock.close();
        }
      },
      async launch({
        parentPid = process.pid,
        args = [],
        failureFile = '',
        waitSeconds = 90,
      } = {}) {
        if (handedOff) throw failure('desktop:upgrade.macUpdateBusy');
        if (
          !Number.isSafeInteger(parentPid) ||
          parentPid <= 0 ||
          !Array.isArray(args) ||
          args.some((arg) => typeof arg !== 'string') ||
          !Number.isSafeInteger(waitSeconds) ||
          waitSeconds < 1 ||
          (failureFile && !isAbsolute(failureFile))
        )
          throw location();
        checkCancellation(signal);
        handedOff = true;
        try {
          await startHelper(
            [
              join(stage, 'install.sh'),
              application,
              stage,
              directory,
              String(parentPid),
              String(original.dev) + ':' + String(original.ino),
              expectedVersion,
              executable,
              receipt === 'true' ? 'receipt' : 'launchservices',
              String(waitSeconds),
              failureFile,
              ...args,
            ],
            lock,
          );
        } catch (error) {
          handedOff = false;
          throw failure('desktop:upgrade.macPrepareFailed', { reason: error.message });
        }
        await lock.close();
      },
    };
  } catch (error) {
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {});
    if (lock) await lock.close().catch(() => {});
    checkCancellation(signal);
    if (error.phrase) throw error;
    throw failure('desktop:upgrade.macPrepareFailed', {
      reason: String(error.stderr || error.message).trim(),
    });
  }
}
async function applicationProcesses(application) {
  const { stdout } = await execute('/usr/bin/osascript', [
    '-l',
    'JavaScript',
    '-e',
    `
      ObjC.import('AppKit');
      function run(paths) {
        const running = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('io.github.ccdesktunnel.desktop');
        const pids = [];
        for (let i = 0; i < running.count; i++) {
          const app = running.objectAtIndex(i);
          if (ObjC.unwrap(app.bundleURL.URLByResolvingSymlinksInPath.path) === paths[0])
            pids.push(Number(app.processIdentifier));
        }
        return JSON.stringify(pids);
      }`,
    application,
  ]);
  return JSON.parse(stdout).filter((pid) => Number.isSafeInteger(pid) && pid !== process.pid);
}

// A receipt belongs only to a private update staging directory beside this exact application.
function writeUpdateReceipt(application, receipt, version) {
  if (!application || !receipt) return;
  const directory = dirname(receipt);
  const prefix = `.${basename(application)}.ccdt-update-`;
  const suffix = basename(directory).slice(prefix.length);
  if (
    basename(receipt) !== 'ready' ||
    dirname(directory) !== dirname(application) ||
    !basename(directory).startsWith(prefix) ||
    !/^[A-Za-z0-9]{6}$/.test(suffix)
  )
    return;
  try {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) return;
    writeFileSync(receipt, version, { flag: 'wx', mode: 0o600 });
  } catch {}
}

// Each app process, including a sign-in window, has a control socket keyed by its installation.
// Older clients also have a socket for each signed-in connection.
function macInstaller({ app, dialog, profile, otherConnections, programArguments, t }) {
  const application = realpathSync(resolve(dirname(app.getPath('exe')), '..', '..'));
  const failureFile = join(profile, 'macos-update-failure.txt');
  const receiptArgument = process.argv.find((arg) => arg.startsWith('--ccdt-update-receipt='));
  const receipt = receiptArgument?.slice('--ccdt-update-receipt='.length);
  return {
    releaseOptions(version, { connected }) {
      if (!connected) throw failure('desktop:upgrade.connectFirst');
      if (
        typeof version !== 'string' ||
        !/^\d+\.\d+\.\d+$/.test(version) ||
        version.localeCompare(app.getVersion(), undefined, { numeric: true }) <= 0
      )
        throw failure('desktop:download.badVersion');
      if (!['arm64', 'x64'].includes(process.arch)) throw failure('desktop:upgrade.unsupported');
      return { name: `CC-Desk-Tunnel-${version}-mac-${process.arch}.dmg` };
    },
    instances: () => applicationProcesses(application),
    async requestQuit(pid) {
      if (await connections.tell(application, String(pid), 'quit')) return;
      const entry = otherConnections().find(({ id }) => {
        try {
          return (
            JSON.parse(
              readFileSync(join(connections.directory(profile, id), 'instance.json'), 'utf8'),
            ).pid === pid
          );
        } catch {
          return false;
        }
      });
      if (entry) await connections.tell(profile, entry.id, 'quit');
    },
    async prepare({ file, version, directory, signal, report }) {
      report({ phase: 'preparing' });
      const staged = await prepareMacUpdate({
        installer: file,
        application,
        expectedVersion: version,
        arch: process.arch,
        directory,
        signal,
      });
      return {
        cancel: staged.cancel,
        install: () => staged.launch({ args: programArguments(), failureFile }),
      };
    },
    onAppReady() {
      connections.listen(application, String(process.pid), { quit: () => app.quit() });
    },
    onRendererReady() {
      writeUpdateReceipt(application, receipt, app.getVersion());
    },
    async onWindowReady(window) {
      try {
        const detail = readFileSync(failureFile, 'utf8').slice(0, 3000);
        await rm(failureFile, { force: true });
        await dialog.showMessageBox(window, {
          type: 'error',
          title: t('desktop:upgrade.title'),
          message: t('desktop:upgrade.macRollback'),
          detail,
        });
      } catch {}
    },
  };
}
module.exports = { prepareMacUpdate, macInstaller };
