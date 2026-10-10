import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ServiceUpdate } from '@cc-desk-tunnel/protocol';

const run = promisify(execFile);
const versionPattern = /^\d+\.\d+\.\d+$/;
type Manifest = {
  version: string;
  runtime: number;
  files: { name: string; size: number; sha256: string }[];
  // Where each file of the release is downloaded from.
  assets: Map<string, string>;
};
export type UpdateOptions = {
  // owner/name of the GitHub repository whose releases are followed, and a read-only token while it is private.
  repository: string;
  token?: string;
  // Where upgraded programs are kept and the level of the runtime around this process; without both, a newer
  // release can only be reported.
  programDir?: string;
  runtimeDir?: string;
  clientDir: string;
  api?: string;
  // The program directory was switched: end the process so that the supervisor starts the new one.
  restart: () => void;
  // How a download is paced, in milliseconds; the defaults unless a test shortens them.
  download?: Partial<typeof downloadPace>;
};
// A connection to the release host can start fast and then slow to a crawl, or stop without closing. A file is
// therefore fetched in stretches: each connection is used for `stretch` at most and the next one continues
// where it ended; one that delivers nothing for `stall` is given up at once. After `attempts` connections in a
// row that added nothing the download fails. `retry` is how long the installer for clients waits before it is
// tried again.
const downloadPace = { stretch: 20_000, stall: 15_000, attempts: 5, retry: 300_000 };
// The installer being fetched for clients, and how far it is.
export type InstallerProgress = { version: string; received: number; size: number };

// The release version of this program; the two sides share the desktop client's number.
export function serviceVersion(): string {
  return JSON.parse(readFileSync(new URL('../../desktop/package.json', import.meta.url), 'utf8'))
    .version;
}
export function isNewer(candidate: string, current: string) {
  const [a, b] = [candidate, current].map((version) => version.split('.').map(Number));
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}

// Follows the project's GitHub releases. A newer release is announced to clients; when the runtime around this
// process is recent enough it can be installed from here: the program goes into the data directory and the
// process ends, to be started again from the new directory. Nothing is installed without a client asking.
export class ServiceUpdates {
  state: ServiceUpdate = { state: 'idle' };
  readonly version = serviceVersion();
  private options: UpdateOptions;
  private manifest: Manifest | undefined;
  private notify: (state: ServiceUpdate) => void;
  private pending: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private pace: typeof downloadPace;
  private stopped = false;
  // The installer of this version on its way into the client directory; undefined once it is there or while
  // nothing is being fetched.
  preparing: InstallerProgress | undefined;
  private fetching: Promise<void> | undefined;
  private retry: NodeJS.Timeout | undefined;
  constructor(options: UpdateOptions, notify: (state: ServiceUpdate) => void) {
    this.options = options;
    this.notify = notify;
    this.pace = { ...downloadPace, ...options.download };
  }
  get installing() {
    return this.state.state === 'installing' || this.state.state === 'restarting';
  }
  start() {
    const first = setTimeout(() => void this.check(), 60_000);
    first.unref();
    this.timer = setInterval(() => void this.check(), 6 * 3600_000);
    this.timer.unref();
    // Clients need the installer of this version. It is fetched beside the running service, never as a step
    // of an upgrade: the service is useful without it, and a client can also get it from the release page.
    this.prepareInstaller();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.retry);
  }
  // Fetches the installer of this version unless it is here or already on its way; tried again later after a
  // failure. Called at start and whenever a client of another version signs in.
  prepareInstaller() {
    if (this.fetching || this.stopped) return;
    clearTimeout(this.retry);
    this.fetching = this.release(`tags/v${this.version}`)
      .then((manifest) => this.installer(manifest))
      .catch(() => {
        if (this.stopped) return;
        this.retry = setTimeout(() => this.prepareInstaller(), this.pace.retry);
        this.retry.unref();
      })
      .finally(() => {
        this.preparing = undefined;
        this.fetching = undefined;
      });
  }
  private set(state: ServiceUpdate) {
    this.state = state;
    this.notify(state);
  }
  private async get(
    url: string,
    accept: string,
    headers: Record<string, string> = {},
    signal: AbortSignal = AbortSignal.timeout(60_000),
  ) {
    const response = await fetch(url, {
      headers: {
        Accept: accept,
        'User-Agent': 'cc-desk-tunnel',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
        ...headers,
      },
      signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(
        response.status === 404 || response.status === 401 || response.status === 403
          ? `发布页无法访问（${response.status}）；跟踪私有仓库时需要在服务端配置只读令牌。`
          : `发布页请求失败（${response.status}）。`,
      );
    }
    return response;
  }
  private async release(which: string): Promise<Manifest> {
    const api = this.options.api ?? 'https://api.github.com';
    const release = (await (
      await this.get(
        `${api}/repos/${this.options.repository}/releases/${which}`,
        'application/vnd.github+json',
      )
    ).json()) as { assets?: { name: string; url: string }[] };
    const assets = new Map((release.assets ?? []).map((asset) => [asset.name, asset.url]));
    const url = assets.get('release.json');
    if (!url) throw new Error('该发布没有 release.json。');
    const manifest = (await (await this.get(url, 'application/octet-stream')).json()) as Manifest;
    if (
      !versionPattern.test(manifest.version) ||
      !Array.isArray(manifest.files) ||
      manifest.files.some(
        (file) => !/^[\w.-]+$/.test(file.name) || !/^[0-9a-f]{64}$/.test(file.sha256),
      )
    )
      throw new Error('release.json 格式不符。');
    return { ...manifest, runtime: Number(manifest.runtime) || 1, assets };
  }
  // Downloads one file of the release, in stretches (see `downloadPace`), and keeps it only if its hash is the
  // one the manifest states.
  private async download(
    manifest: Manifest,
    name: string,
    target: string,
    progress: (received: number) => void = () => {},
  ) {
    const file = manifest.files.find((item) => item.name === name);
    const url = manifest.assets.get(name);
    if (!file || !url) throw new Error(`发布中缺少 ${name}。`);
    const partial = `${target}.part`;
    const { stretch, stall, attempts } = this.pace;
    const output = await open(partial, 'w');
    try {
      let received = 0;
      let last: unknown;
      for (let idle = 0; received < file.size;) {
        if (idle >= attempts)
          throw new Error(`${name} 下载中断：${(last as Error)?.message || '连接没有数据'}。`);
        if (this.stopped) throw new Error('服务正在停止。');
        const before = received;
        const controller = new AbortController();
        const end = setTimeout(() => controller.abort(), stretch);
        let quiet = setTimeout(() => controller.abort(), stall);
        try {
          const response = await this.get(
            url,
            'application/octet-stream',
            received ? { Range: `bytes=${received}-` } : {},
            controller.signal,
          );
          // A host that does not continue a file sends all of it again.
          if (received && response.status !== 206) {
            received = 0;
            await output.truncate(0);
          }
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            clearTimeout(quiet);
            quiet = setTimeout(() => controller.abort(), stall);
            await output.write(chunk, 0, chunk.length, received);
            received += chunk.length;
            if (received > file.size) throw new Error(`${name} 比发布清单里的大。`);
            progress(received);
          }
        } catch (error) {
          // A stretch that ran out, or a connection that failed, only ends this connection; anything the
          // release host refuses outright, or a file that is not the announced one, ends the download.
          if (!controller.signal.aborted && !(error instanceof TypeError)) throw error;
          last = error;
        } finally {
          clearTimeout(end);
          clearTimeout(quiet);
        }
        idle = received > before ? 0 : idle + 1;
      }
    } catch (error) {
      await output.close();
      await rm(partial, { force: true });
      throw error;
    }
    await output.close();
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(partial)) hash.update(chunk);
    if (hash.digest('hex') !== file.sha256) {
      await rm(partial, { force: true });
      throw new Error(`${name} 校验失败。`);
    }
    await rename(partial, target);
  }
  private async installer(manifest: Manifest) {
    const name = `CC-Desk-Tunnel-Setup-${manifest.version}-x64.exe`;
    const target = join(this.options.clientDir, name);
    if (existsSync(target)) return;
    mkdirSync(this.options.clientDir, { recursive: true });
    const size = manifest.files.find((item) => item.name === name)?.size ?? 0;
    this.preparing = { version: manifest.version, received: 0, size };
    await this.download(manifest, name, target, (received) => {
      this.preparing = { version: manifest.version, received, size };
    });
  }
  private runtimeLevel() {
    try {
      return Number(readFileSync(join(this.options.runtimeDir!, 'level'), 'utf8').trim()) || 0;
    } catch {
      return 0;
    }
  }
  check() {
    if (this.installing) return Promise.resolve();
    this.pending ??= (async () => {
      const previous = this.state;
      this.set({ ...previous, state: 'checking', detail: undefined });
      try {
        const manifest = await this.release('latest');
        const checkedAt = Date.now();
        if (!isNewer(manifest.version, this.version)) {
          this.manifest = undefined;
          this.set({ state: 'idle', checkedAt });
        } else {
          this.manifest = manifest;
          const automatic = !!this.options.programDir && this.runtimeLevel() >= manifest.runtime;
          this.set({
            state: automatic ? 'available' : 'manual',
            latest: manifest.version,
            checkedAt,
          });
        }
      } catch (error) {
        this.manifest = undefined;
        this.set({ state: 'failed', detail: (error as Error).message, checkedAt: Date.now() });
      }
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  // Runs in the background; progress and the outcome reach clients as state changes.
  install(version: string) {
    const manifest = this.manifest;
    if (this.state.state !== 'available' || !manifest || manifest.version !== version)
      throw new Error('没有可安装的这一版本，请先检查更新。');
    const root = this.options.programDir!;
    const target = join(root, version);
    const work = join(root, `${version}.new`);
    const step = (detail: string) => this.set({ state: 'installing', latest: version, detail });
    step('下载服务端程序');
    void (async () => {
      try {
        // Only the running program is kept beside the new one.
        mkdirSync(root, { recursive: true });
        for (const name of readdirSync(root))
          if (/^\d+\.\d+\.\d+(\.|$)/.test(name) && name !== this.version)
            await rm(join(root, name), { recursive: true, force: true });
        mkdirSync(work, { recursive: true });
        const archive = join(root, `${version}.tar.gz`);
        await this.download(manifest, `cc-desk-tunnel-server-${version}.tar.gz`, archive);
        const { stdout } = await run('tar', ['-tzf', archive], { maxBuffer: 16 << 20 });
        if (
          stdout.split('\n').some((path) => path.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(path))
        )
          throw new Error('程序包内含不安全的路径。');
        await run('tar', ['-xzf', archive, '-C', work, '--no-same-owner']);
        await rm(archive, { force: true });
        step('安装依赖');
        const options = { cwd: work, timeout: 900_000, maxBuffer: 16 << 20 };
        await run(
          'npm',
          [
            'ci',
            '--omit=dev',
            '--workspace=@cc-desk-tunnel/server',
            '--workspace=@cc-desk-tunnel/protocol',
          ],
          options,
        );
        // The release names the Claude Code it was built against; the image's copy is used when it is that one.
        const wanted = /^CLAUDE_VERSION=([\w.-]+)$/m.exec(
          readFileSync(join(work, 'scripts/install-linux.sh'), 'utf8'),
        )?.[1];
        const bundled = await run(join(this.options.runtimeDir!, 'cli/bin/claude'), ['--version'])
          .then((result) => result.stdout.split(' ')[0].trim())
          .catch(() => '');
        if (wanted && wanted !== bundled) {
          step(`安装 Claude Code ${wanted}`);
          await run(
            'npm',
            [
              'install',
              '--global',
              '--prefix',
              join(work, 'cli'),
              `@anthropic-ai/claude-code@${wanted}`,
            ],
            options,
          );
          await run(join(work, 'cli/bin/claude'), ['--version']);
        }
        await rm(target, { recursive: true, force: true });
        await rename(work, target);
        await rm(join(root, 'attempts'), { force: true });
        await writeFile(join(root, 'current.new'), `${version}\n`);
        await rename(join(root, 'current.new'), join(root, 'current'));
        this.set({ state: 'restarting', latest: version });
        this.options.restart();
      } catch (error) {
        await rm(work, { recursive: true, force: true }).catch(() => undefined);
        const reason = (error as { stderr?: string }).stderr?.trim().split('\n').at(-1);
        this.set({
          state: 'failed',
          latest: version,
          detail: `升级没有完成，仍在运行 ${this.version}：${reason || (error as Error).message}`,
        });
      }
    })();
  }
}
