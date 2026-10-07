import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
};

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
  constructor(options: UpdateOptions, notify: (state: ServiceUpdate) => void) {
    this.options = options;
    this.notify = notify;
  }
  get installing() {
    return this.state.state === 'installing' || this.state.state === 'restarting';
  }
  start() {
    const first = setTimeout(() => void this.check(), 60_000);
    first.unref();
    this.timer = setInterval(() => void this.check(), 6 * 3600_000);
    this.timer.unref();
    // After an upgrade made on the server itself, clients still need the installer of this version.
    void this.release(`tags/v${this.version}`)
      .then((manifest) => this.installer(manifest))
      .catch(() => undefined);
  }
  stop() {
    clearInterval(this.timer);
  }
  private set(state: ServiceUpdate) {
    this.state = state;
    this.notify(state);
  }
  private async get(url: string, accept: string) {
    const response = await fetch(url, {
      headers: {
        Accept: accept,
        'User-Agent': 'cc-desk-tunnel',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
      },
      signal: AbortSignal.timeout(900_000),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(
        response.status === 404 || response.status === 401 || response.status === 403
          ? `发布页无法访问（${response.status}）；仓库未公开时需要在服务端配置只读令牌。`
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
  // Downloads one file of the release and keeps it only if its hash is the one the manifest states.
  private async download(manifest: Manifest, name: string, target: string) {
    const file = manifest.files.find((item) => item.name === name);
    const url = manifest.assets.get(name);
    if (!file || !url) throw new Error(`发布中缺少 ${name}。`);
    const hash = createHash('sha256');
    const partial = `${target}.part`;
    await pipeline(
      Readable.fromWeb((await this.get(url, 'application/octet-stream')).body as never),
      new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(partial),
    );
    if (hash.digest('hex') !== file.sha256) {
      rmSync(partial, { force: true });
      throw new Error(`${name} 校验失败。`);
    }
    await rename(partial, target);
  }
  private async installer(manifest: Manifest) {
    const name = `CC-Desk-Tunnel-Setup-${manifest.version}-x64.exe`;
    const target = join(this.options.clientDir, name);
    if (existsSync(target)) return;
    mkdirSync(this.options.clientDir, { recursive: true });
    await this.download(manifest, name, target);
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
        step('下载客户端安装包');
        await this.installer(manifest);
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
