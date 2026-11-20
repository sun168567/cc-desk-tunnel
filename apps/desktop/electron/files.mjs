import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { FILES_TARGET_ENV } from '@cc-desk-tunnel/protocol';

// The file panel's files, wherever they are: `local` is this computer's, read here; `server` is the service's,
// and any other target is one of the user's computers by its ID, both reached over SFTP. The SFTP sessions go
// through one SSH connection to the service, which `open` makes (see `openFiles` in proxy-bridge.mjs) and which
// is made again when it has gone; the service hands each session to the SFTP server of its target.
//
// Paths are as the target names them: this computer's own, the service's POSIX ones, and those of a Windows
// computer as its OpenSSH writes them (`/C:/Users/...`, see `sftpPath`). A transfer is a copy from one target to
// another: SFTP's own parallel transfer where this computer is one end, through a file here between two others.
// An unfinished copy stays as far as it got, and may be resumed.

const S_IFMT = 0o170000;
const kindOf = (mode) =>
  ({ 0o040000: 'directory', 0o100000: 'file', 0o120000: 'link' })[mode & S_IFMT] ?? 'other';
// How far the panel reads a file to show it.
export const PREVIEW_LIMIT = 2 * 1024 * 1024;
export const IMAGE_LIMIT = 10 * 1024 * 1024;

// A Windows path as the computer's OpenSSH names it.
export function sftpPath(file, platform) {
  return platform === 'win32' ? '/' + String(file).replaceAll('\\', '/') : String(file);
}
const join = (target, directory, name) =>
  target === 'local' ? path.join(directory, name) : path.posix.join(directory, name);
const parent = (target, file) =>
  target === 'local' ? path.dirname(file) : path.posix.dirname(file);
const baseName = (target, file) =>
  target === 'local' ? path.basename(file) : path.posix.basename(file);

const call = (run) =>
  new Promise((resolve, reject) => run((error, value) => (error ? reject(error) : resolve(value))));

// The same few operations on this computer's files and over SFTP.
const localFiles = {
  async list(directory) {
    const names = await readdir(directory);
    const entries = await Promise.all(
      names.map(async (name) => {
        try {
          const info = await lstat(path.join(directory, name));
          const entry = {
            name,
            kind: info.isDirectory()
              ? 'directory'
              : info.isSymbolicLink()
                ? 'link'
                : info.isFile()
                  ? 'file'
                  : 'other',
            size: info.size,
            mtime: info.mtimeMs,
          };
          if (entry.kind === 'link')
            entry.target = await stat(path.join(directory, name)).then(
              (to) => (to.isDirectory() ? 'directory' : 'file'),
              () => null,
            );
          return entry;
        } catch {
          return null;
        }
      }),
    );
    return entries.filter(Boolean);
  },
  async stat(file) {
    const info = await stat(file);
    return {
      kind: info.isDirectory() ? 'directory' : 'file',
      size: info.size,
      mtime: info.mtimeMs,
    };
  },
  async read(file, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of createReadStream(file, { end: limit - 1 })) {
      chunks.push(chunk);
      size += chunk.length;
    }
    return Buffer.concat(chunks, size);
  },
  mkdir: (directory) => mkdir(directory),
  rename: (from, to) => rename(from, to),
  remove: (file) => rm(file, { recursive: true, force: false }),
};

function sftpFiles(sftp) {
  const files = {
    async list(directory) {
      const items = await call((done) => sftp.readdir(directory, done));
      return Promise.all(
        items.map(async ({ filename, attrs }) => {
          const entry = {
            name: filename,
            kind: kindOf(attrs.mode),
            size: attrs.size,
            mtime: attrs.mtime * 1000,
          };
          if (entry.kind === 'link')
            entry.target = await call((done) =>
              sftp.stat(path.posix.join(directory, filename), done),
            ).then(
              (to) => (kindOf(to.mode) === 'directory' ? 'directory' : 'file'),
              () => null,
            );
          return entry;
        }),
      );
    },
    async stat(file) {
      const info = await call((done) => sftp.stat(file, done));
      return {
        kind: kindOf(info.mode) === 'directory' ? 'directory' : 'file',
        size: info.size,
        mtime: info.mtime * 1000,
      };
    },
    async read(file, limit) {
      const chunks = [];
      let size = 0;
      for await (const chunk of sftp.createReadStream(file, { start: 0, end: limit - 1 })) {
        chunks.push(chunk);
        size += chunk.length;
      }
      return Buffer.concat(chunks, size);
    },
    mkdir: (directory) => call((done) => sftp.mkdir(directory, done)),
    rename: (from, to) => call((done) => sftp.rename(from, to, done)),
    // SFTP removes one entry at a time: a directory goes after what is in it.
    async remove(file) {
      const info = await call((done) => sftp.lstat(file, done));
      if (kindOf(info.mode) !== 'directory') return call((done) => sftp.unlink(file, done));
      for (const entry of await files.list(file))
        await files.remove(path.posix.join(file, entry.name));
      await call((done) => sftp.rmdir(file, done));
    },
  };
  return files;
}

// Says what went wrong in the user's words. SFTP's status codes come as `code`.
export function fileError(error, target) {
  const code = error?.code;
  if (code === 2 || code === 'ENOENT') return '文件或文件夹不存在。';
  if (code === 3 || code === 'EACCES' || code === 'EPERM')
    return target === 'server'
      ? '没有权限。服务端的密钥、登录凭据和服务数据受保护，不能读取或修改。'
      : '没有权限访问这个位置。';
  if (code === 'EEXIST' || code === 'ENOTEMPTY') return '目标位置已有同名文件或文件夹。';
  return error?.message || String(error);
}

export function createFiles({ open }) {
  let client = null;
  let connecting = null;
  // The SFTP session of each target the panel looks at; transfers open their own, which end with them.
  const sessions = new Map();
  let closed = false;
  function connection() {
    if (client) return Promise.resolve(client);
    connecting ??= (async () => {
      // Loaded when the panel first reaches the service, not with every connection's main process.
      const { default: ssh2 } = await import('ssh2');
      const stream = await open();
      const created = new ssh2.Client();
      await new Promise((resolve, reject) => {
        created.once('ready', resolve);
        created.once('error', reject);
        // The connection was signed in to the service already, and its certificate checked: SSH asks no more.
        created.connect({
          sock: stream,
          username: 'files',
          hostVerifier: () => true,
          readyTimeout: 20000,
        });
      }).catch((error) => {
        stream.destroy();
        throw error;
      });
      created.on('error', () => {});
      created.once('close', () => {
        if (client === created) client = null;
        sessions.clear();
      });
      if (closed) {
        created.end();
        throw new Error('文件连接已关闭。');
      }
      client = created;
      return created;
    })().finally(() => (connecting = null));
    return connecting;
  }
  async function openSftp(target) {
    const ssh = await connection();
    return new Promise((resolve, reject) =>
      ssh.sftp({ [FILES_TARGET_ENV]: target }, (error, sftp) =>
        error
          ? reject(
              new Error(
                target === 'server'
                  ? '服务端没有提供文件访问。'
                  : '这台电脑现在连不上：它可能不在线，或执行通道尚未就绪。',
              ),
            )
          : // Requests still out when the connection goes fail on their own; the session has nothing more to say.
            resolve(sftp.on('error', () => {})),
      ),
    );
  }
  function session(target) {
    let opened = sessions.get(target);
    if (!opened) {
      opened = openSftp(target);
      sessions.set(target, opened);
      opened.then(
        (sftp) =>
          sftp.once('close', () => sessions.get(target) === opened && sessions.delete(target)),
        () => sessions.get(target) === opened && sessions.delete(target),
      );
    }
    return opened;
  }
  async function on(target) {
    return target === 'local' ? localFiles : sftpFiles(await session(target));
  }
  const operations = {
    list: async (target, directory) => (await on(target)).list(directory),
    stat: async (target, file) => (await on(target)).stat(file),
    read: async (target, file, limit = PREVIEW_LIMIT) => {
      const files = await on(target);
      const { size } = await files.stat(file);
      const bytes = await files.read(file, Math.min(limit, IMAGE_LIMIT));
      return { bytes, size, truncated: size > bytes.length };
    },
    // Where a target starts: the home directory of the user it runs as.
    home: async (target) => {
      if (target === 'local') return homedir();
      const sftp = await session(target);
      return call((done) => sftp.realpath('.', done));
    },
    mkdir: async (target, directory) => (await on(target)).mkdir(directory),
    rename: async (target, from, to) => (await on(target)).rename(from, to),
    remove: async (target, files) => {
      const on_ = await on(target);
      for (const file of files) await on_.remove(file);
    },
    // Whether each name is taken in a directory, to ask before a copy replaces anything.
    exists: async (target, directory, names) => {
      const files = await on(target);
      return Promise.all(
        names.map((name) =>
          files.stat(join(target, directory, name)).then(
            () => true,
            () => false,
          ),
        ),
      );
    },
  };
  // Copies files and directories from one target into a directory of another. `conflict` says what happens to a
  // file the destination has already: `replace` it, `skip` it, or `resume` a copy that stopped part way (a
  // shorter file is taken to be its beginning). `progress` hears of the bytes done; `signal` stops the copy, and
  // what was written so far stays.
  async function transfer({ from, to, conflict = 'replace', progress = () => {}, signal }) {
    if (signal?.aborted) throw new Error('已取消');
    const own = [];
    // The copy's own SFTP sessions, which stopping it ends.
    async function own_(target) {
      if (target === 'local') return null;
      const sftp = await openSftp(target);
      own.push(sftp);
      return sftp;
    }
    const stop = () => own.forEach((sftp) => sftp.end());
    signal?.addEventListener('abort', stop, { once: true });
    try {
      const source = await own_(from.target);
      const destination = await own_(to.target);
      const read = source ? sftpFiles(source) : localFiles;
      const write = destination ? sftpFiles(destination) : localFiles;
      // What is to be copied, files with their sizes, each with where it goes.
      const plan = [];
      async function walk(file, into) {
        const info = await read.stat(file);
        const target = join(to.target, into, baseName(from.target, file));
        if (info.kind === 'directory') {
          plan.push({ directory: target });
          for (const entry of await read.list(file))
            if (entry.kind === 'directory' || entry.kind === 'file' || entry.target)
              await walk(join(from.target, file, entry.name), target);
        } else plan.push({ file, target, size: info.size });
      }
      for (const file of from.paths) await walk(file, to.dir);
      const total = plan.reduce((sum, item) => sum + (item.size ?? 0), 0);
      let done = 0;
      let last = 0;
      const tell = (name, force) => {
        const now = Date.now();
        if (!force && now - last < 100) return;
        last = now;
        progress({ done, total, name });
      };
      let temporary;
      for (const item of plan) {
        if (signal?.aborted) throw new Error('已取消');
        if (item.directory) {
          await write.mkdir(item.directory).catch(() => {});
          continue;
        }
        const existing = await write.stat(item.target).catch(() => null);
        let start = 0;
        if (existing) {
          if (conflict === 'skip') {
            done += item.size;
            continue;
          }
          if (conflict === 'resume' && existing.size <= item.size) start = existing.size;
        }
        const name = baseName(from.target, item.file);
        const step = (count) => {
          done += count;
          tell(name);
        };
        if (start === item.size) {
          done += item.size;
        } else if (start > 0 || (source && destination)) {
          // Resuming, or between two targets that are not this computer: the stream's way, from where it stopped.
          if (source && destination && start === 0) {
            // Through a file here, so that both legs go at SFTP's parallel speed.
            temporary ??= await mkdtemp(path.join(tmpdir(), 'cc-desk-tunnel-copy-'));
            const between = path.join(temporary, 'part');
            await call((done_) =>
              source.fastGet(item.file, between, { step: (_all, chunk) => step(chunk / 2) }, done_),
            );
            await call((done_) =>
              destination.fastPut(
                between,
                item.target,
                { step: (_all, chunk) => step(chunk / 2) },
                done_,
              ),
            );
            await rm(between, { force: true });
          } else {
            done += start;
            const input = source
              ? source.createReadStream(item.file, { start })
              : createReadStream(item.file, { start });
            const output = destination
              ? destination.createWriteStream(item.target, { flags: start ? 'r+' : 'w', start })
              : createWriteStream(item.target, { flags: start ? 'r+' : 'w', start });
            input.on('data', (chunk) => step(chunk.length));
            await pipeline(input, output, { signal });
          }
        } else if (source) {
          await call((done_) =>
            source.fastGet(item.file, item.target, { step: (_all, chunk) => step(chunk) }, done_),
          );
        } else if (destination) {
          await call((done_) =>
            destination.fastPut(
              item.file,
              item.target,
              { step: (_all, chunk) => step(chunk) },
              done_,
            ),
          );
        } else {
          await copyFile(item.file, item.target);
          done += item.size;
        }
        tell(name, true);
      }
      if (temporary) await rm(temporary, { recursive: true, force: true });
      return { files: plan.filter((item) => item.file).length, bytes: total };
    } catch (error) {
      if (signal?.aborted) throw new Error('已取消');
      throw new Error(fileError(error, to.target), { cause: error });
    } finally {
      signal?.removeEventListener('abort', stop);
      stop();
    }
  }
  return {
    ...Object.fromEntries(
      Object.entries(operations).map(([name, run]) => [
        name,
        async (target, ...args) => {
          try {
            return await run(target, ...args);
          } catch (error) {
            throw new Error(fileError(error, target), { cause: error });
          }
        },
      ]),
    ),
    transfer,
    parent,
    close() {
      closed = true;
      client?.end();
      client = null;
      sessions.clear();
    },
  };
}

// The changes git sees in a project of this computer, each a path from the project's folder with its status
// letter (`M` changed, `A` added, `D` removed, `R` renamed, `?` new and untracked); null outside a
// repository or without git. Untracked folders count as one entry, as `git status` shows them.
export function gitChanges(directory) {
  return new Promise((resolve) =>
    execFile(
      'git',
      ['-C', String(directory), 'status', '--porcelain=v1', '-z', '--no-renames'],
      { maxBuffer: 16 * 1024 * 1024, timeout: 15000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(null);
        const changes = [];
        for (const record of stdout.split('\0')) {
          if (record.length < 4) continue;
          const status = record.slice(0, 2);
          const letter = status === '??' ? '?' : (status.trim()[0] ?? 'M');
          changes.push({ path: record.slice(3), status: letter });
        }
        resolve(changes.slice(0, 2000));
      },
    ),
  );
}
