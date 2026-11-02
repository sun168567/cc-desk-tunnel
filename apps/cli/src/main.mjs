import { appendFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { upgradeService } from '../../desktop/electron/service-upgrade.mjs';
import { Config } from './config.mjs';
import { Service, proxyFor } from './connection.mjs';
import { readKeys } from './keys.mjs';
import { pick } from './picker.mjs';
import { discard, protect, reveal } from './secret.mjs';
import { bundled, releasePage, version } from './runtime.mjs';
import { relay } from './terminal.mjs';
import { FIRST_UPGRADABLE, download, install } from './upgrade.mjs';

const HELP = `ccdt：在自己的终端里使用 CC Desk Tunnel 服务端上的原版 Claude Code，与图形客户端共用会话。

用法：
  ccdt                   接着当前目录这个项目最近的会话；没有就新建
  ccdt -r                从当前项目的会话里选一个打开（加 --all 从全部会话里选）
  ccdt new [标题]        在当前目录新建会话
  ccdt sessions [--all]  列出当前项目的会话；--all 列出全部
  ccdt usage             订阅额度与调用统计
  ccdt login [wss 地址]  登录服务端；不写地址时用图形客户端保存的。--fingerprint 证书指纹，
                         --token-stdin 从标准输入读凭据，--no-save 不保存
  ccdt logout            退出当前服务端
  ccdt open <会话 ID>    按 ID 打开（ID 可只写开头几位），供脚本使用
  ccdt upgrade [--yes]   升级服务端（升级前会问；--yes 不问），再把 ccdt 换成与服务端相同的版本
  ccdt --version         版本，须与服务端相同

选项：--server <wss 地址> 在登录过的几个服务端里选一个。

用法和本地的 claude 一样：窗口开着它就一直运行，断网会自动接回；退出 Claude Code 或关掉窗口就结束。
终端里聊的内容会记入这个会话，图形客户端里也能看到。`;

const say = (text) => process.stderr.write(`${text}\n`);
// `CCDT_LOG` names a file for what the connection did, for finding out why it failed.
const log = (line) => {
  if (process.env.CCDT_LOG)
    appendFileSync(process.env.CCDT_LOG, `${new Date().toISOString()} ${line}\n`);
};
const dim = (text) => (process.stderr.isTTY ? `\x1b[2m${text}\x1b[0m` : text);

// The session's project directory as the desktop client records it, compared without the case on Windows.
const sameDirectory = (a, b) => {
  const normal = (path) => resolve(path).replace(/[\\/]+$/, '');
  return process.platform === 'win32'
    ? normal(a).toLowerCase() === normal(b).toLowerCase()
    : normal(a) === normal(b);
};
const newest = (sessions) => sessions.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
const when = (time) => {
  const date = new Date(time);
  const today = new Date().toDateString() === date.toDateString();
  const pad = (value) => String(value).padStart(2, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return today ? `今天 ${clock}` : `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
};
// Who is using the session now: a terminal of ccdt, which reports what its CLI is doing, the native terminal of a
// desktop window, or a run started from the desktop client.
const TERMINAL = { working: '终端运行中', waiting: '终端等你确认', idle: '终端打开中' };
const using = (run) =>
  run.surface !== 'terminal'
    ? '图形客户端运行中'
    : (TERMINAL[run.activity] ?? '图形客户端的原生终端打开中');
const status = (session) => (session.activeRun ? ` [${using(session.activeRun)}]` : '');

async function readSecret(prompt) {
  const input = process.stdin;
  if (!input.isTTY) {
    let text = '';
    for await (const chunk of input) text += chunk;
    return text.trim();
  }
  process.stderr.write(prompt);
  let text = '';
  try {
    return await readKeys(input, (chunk) => {
      for (const key of chunk) {
        if (key === '\r' || key === '\n') return text;
        if (key === '\u0003') throw new Error('已取消。');
        text = key === '\u007f' || key === '\b' ? text.slice(0, -1) : text + key;
      }
    });
  } finally {
    process.stderr.write('\n');
  }
}

function credentials(config, values) {
  const server = config.server(values.server);
  if (!server) throw new Error('还没有登录服务端：先运行 ccdt login。');
  const token = process.env.CCDT_TOKEN || reveal(server.url, server.token);
  if (!token)
    throw new Error('没有保存这个服务端的凭据：运行 ccdt login 重新登录，或设置 CCDT_TOKEN。');
  return { server, token };
}

async function signIn(config, values, quiet = false) {
  const { server, token } = credentials(config, values);
  if (!quiet) say(dim(`正在连接 ${server.url} ……`));
  return Service.connect({ ...server, token, deviceId: config.device(), log });
}

async function login(config, values, url) {
  let server = url ? { url, fingerprint: values.fingerprint ?? '' } : undefined;
  if (!server) {
    const saved = config.desktopLogins();
    if (!saved.length) throw new Error('用法：ccdt login <wss 地址> [--fingerprint 证书指纹]');
    const chosen =
      saved.length === 1
        ? 0
        : await pick(
            '图形客户端保存了这几个服务端，选一个：',
            saved.map((login) => login.url),
          );
    if (chosen === undefined) throw new Error('已取消。');
    server = {
      ...saved[chosen],
      ...(values.fingerprint ? { fingerprint: values.fingerprint } : {}),
    };
    say(`服务端：${server.url}（取自图形客户端）`);
  }
  const token = values['token-stdin']
    ? await readSecret('')
    : process.env.CCDT_TOKEN ||
      (await readSecret('服务凭据（与图形客户端填的相同，输入时不显示）：'));
  say(dim('正在验证……'));
  const service = await Service.connect({ ...server, token, deviceId: config.device() });
  say(`已登录 ${server.url}（服务端版本 ${service.version}）。`);
  await service.close();
  const previous = config.server(server.url);
  if (previous) discard(previous.url, previous.token);
  const kept = values['no-save'] ? undefined : protect(server.url, token);
  config.remember(kept ? { ...server, token: kept } : server);
  if (!kept) say('凭据没有保存；之后用 CCDT_TOKEN 环境变量提供。');
  else if (kept.store === 'file')
    say(dim(`系统没有可用的密钥服务，凭据存在只有本账号可读的 ${config.path}。`));
}

const older = (a, b) => a.localeCompare(b, undefined, { numeric: true }) < 0;

// The service first, the way the desktop client upgrades it: it fetches its newest release and restarts. Then ccdt
// becomes the release of the service, which is what it can speak to: newer, or older where ccdt was ahead of it.
async function upgrade(config, values) {
  const { server, token } = credentials(config, values);
  let current;
  try {
    const service = await signIn(config, values);
    current = service.version;
    await service.close();
  } catch (error) {
    // A service of another release says which it is.
    if (error.code !== 'version_mismatch' || !error.service) throw error;
    current = error.service;
  }
  let target = current;
  // A service newer than ccdt is not asked: this ccdt cannot tell which protocol it speaks.
  if (!older(version, current)) {
    say(dim(`服务端是 ${current}，正在检查新版本……`));
    let installing = false;
    try {
      target = await upgradeService(
        {
          url: server.url,
          fingerprint: server.fingerprint,
          token,
          deviceName: hostname(),
          service: current,
        },
        {
          resolveProxy: async (address) => proxyFor(address),
          confirm: async (latest) => {
            if (values.yes) return true;
            if (!process.stdin.isTTY)
              throw new Error('升级服务端要先确认：在终端里运行 ccdt upgrade，或加 --yes。');
            return (
              (await pick(
                `服务端有新版本 ${latest}（现在是 ${current}）。升级时服务端会重启，进行中的运行和终端要先结束。`,
                ['升级服务端', '不升级'],
              )) === 0
            );
          },
          onUpdate: (update) => {
            if (update.state === 'installing' && !installing) say(dim('服务端正在下载并安装……'));
            installing ||= update.state === 'installing';
          },
        },
      );
      say(`服务端已升级到 ${target}，正在重启，约一分钟后可以连接。`);
    } catch (error) {
      if (error.code === 'current') say(`服务端已是最新的正式版本 ${current}。`);
      else if (error.code === 'declined' || error.code === 'manual') say(error.message);
      else throw error;
    }
  }
  if (target === version) {
    say(`ccdt 是 ${version}，与服务端相同。`);
    return 0;
  }
  if (older(target, FIRST_UPGRADABLE)) {
    say(
      `ccdt 不能自己换成 ${FIRST_UPGRADABLE} 以前的版本：到 ${releasePage(target)} 下载 ccdt ${target}，运行其中的安装脚本。`,
    );
    return 1;
  }
  if (!bundled) {
    say(`从源码运行的 ccdt 不自行更新：服务端是 ${target}，请换到这个版本的源码。`);
    return 1;
  }
  say(dim(`正在下载 ccdt ${target}……`));
  install(await download(target));
  say(`ccdt 已换成 ${target}。`);
  say(dim('其他已打开的 ccdt 窗口仍是原来的版本，关掉重开即可。'));
  return 0;
}

function listed(sessions) {
  return newest(sessions)
    .map(
      (session) =>
        `${session.id.slice(0, 8)}  ${when(session.updatedAt)}  ${session.title}${status(session)}\n          ${dim(`${session.projectPath}${session.device ? `（${session.device.name}）` : ''}`)}`,
    )
    .join('\n');
}

function usage(summary) {
  const names = { five_hour: '5 小时', seven_day: '7 天', seven_day_opus: '7 天 Opus' };
  const lines = summary.windows.map((window) => {
    const used = window.utilization === null ? '—' : `${Math.round(window.utilization)}%`;
    const reset = window.resetsAt ? `，${when(window.resetsAt)} 重置` : '';
    return `${(names[window.name] ?? window.name).padEnd(8)} 已用 ${used}${reset} · ${window.requests} 次请求 · 约 $${window.costUsd.toFixed(2)}`;
  });
  if (!lines.length)
    return '没有订阅额度数据：使用 API Key 或第三方接口时没有额度，用量见图形客户端的统计页。';
  return [
    ...lines,
    dim('金额是按 API 价格估算的等价消耗，不是订阅账单。完整的图表在图形客户端的统计页。'),
  ].join('\n');
}

// Shows the session's terminal until it ends, taking it up again after the connection is lost. Closing the window
// ends it too, as it would a local CLI.
async function show(config, values, service, session, fresh) {
  const shown = {};
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    const ending = shown.terminalId
      ? service
          .request({ type: 'terminal.close', sessionId: session.id, terminalId: shown.terminalId })
          .catch(() => {})
      : Promise.resolve();
    await Promise.race([ending, new Promise((resolve) => setTimeout(resolve, 3000))]);
    await service.close().catch(() => {});
    process.exit(129);
  };
  // Windows sends SIGHUP when the console window is closed, and waits a few seconds before ending the process. On
  // Linux and macOS the terminal is gone with the window, and writing to it or reading from it fails, at times
  // before the signal arrives: that is the window closing too.
  process.once('SIGHUP', close);
  process.once('SIGTERM', close);
  for (const stream of [process.stdin, process.stdout]) stream.on('error', close);
  say(
    `${dim('项目')} ${session.projectPath}  ${dim('会话')} ${session.title}${fresh ? dim('（新建）') : ''}`,
  );
  // A terminal of ccdt is taken over; anything else using the session has to finish first.
  const run = service.sessions.get(session.id)?.activeRun;
  if (run && !(run.surface === 'terminal' && run.activity)) {
    await service.close();
    say(
      run.surface === 'terminal'
        ? '这个会话的原生终端在图形客户端里开着，关掉它再打开。'
        : '这个会话正在图形客户端里运行，这一轮结束后再打开。',
    );
    return 1;
  }
  for (;;) {
    let result;
    try {
      await service.channel();
      result = await relay(service, session.id, shown);
    } catch (error) {
      // Nothing to show, such as a terminal the service would not open: the connection is let go, for ccdt to end.
      await service.close().catch(() => {});
      throw error;
    }
    log(`Terminal shown no longer: ${result.how}.`);
    if (result.how === 'exited') {
      await service.close();
      say(dim('已退出。对话记录在这个会话里，在这个目录运行 ccdt 可以接着聊。'));
      return result.code ?? 0;
    }
    if (result.how === 'taken') {
      await service.close();
      say('这个会话在另一个窗口里打开了，这里不再显示。');
      return 0;
    }
    if (result.how === 'stalled') continue;
    process.stdout.write('\x1b]0;ccdt：连接断开，正在重连\x07');
    say(dim('\r\n连接断开，正在重连……Claude Code 在服务端继续运行。'));
    for (let wait = 1000; ; wait = Math.min(wait * 2, 15000)) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      try {
        service = await signIn(config, values, true);
        break;
      } catch (error) {
        if (error.code === 'unauthorized' || error.code === 'version_mismatch') throw error;
      }
    }
  }
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        resume: { type: 'boolean', short: 'r' },
        server: { type: 'string' },
        fingerprint: { type: 'string' },
        'token-stdin': { type: 'boolean' },
        'no-save': { type: 'boolean' },
        all: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    say(`${error.message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  const config = new Config();
  let service;
  try {
    if (values.help || command === 'help') return (say(HELP), 0);
    if (values.version) return (process.stdout.write(`ccdt ${version}\n`), 0);
    if (command === 'login') return (await login(config, values, rest[0]), 0);
    if (command === 'upgrade') return await upgrade(config, values);
    if (command === 'logout') {
      const server = config.server(values.server);
      if (!server) return (say('没有登录任何服务端。'), 0);
      discard(server.url, server.token);
      config.forget(server.url);
      return (say(`已退出 ${server.url}。`), 0);
    }
    if (command && !['new', 'open', 'sessions', 'usage'].includes(command))
      return (say(`没有这个命令：${command}\n\n${HELP}`), 2);
    service = await signIn(config, values);
    const here = process.cwd();
    const all = [...service.sessions.values()];
    const mine = all.filter((session) => sameDirectory(session.projectPath, here));
    if (command === 'sessions') {
      const sessions = values.all ? all : mine;
      say(
        sessions.length
          ? listed(sessions)
          : values.all
            ? '还没有会话。'
            : '这个目录还没有会话：运行 ccdt 新建一个，或用 ccdt sessions --all 看全部。',
      );
      await service.close();
      return 0;
    }
    if (command === 'usage') {
      say(usage(await service.request({ type: 'usage.summary' })));
      await service.close();
      return 0;
    }
    let session;
    let fresh = false;
    if (command === 'open') {
      const prefix = rest[0]?.toLowerCase();
      const found = prefix ? all.filter((other) => other.id.startsWith(prefix)) : [];
      if (found.length !== 1) {
        await service.close();
        return (say(found.length ? '有几个会话以此开头，请多写几位。' : '没有这个会话。'), 1);
      }
      session = found[0];
    } else if (values.resume) {
      const sessions = newest(values.all ? all : mine);
      if (!sessions.length) {
        await service.close();
        return (
          say('这个目录还没有会话：运行 ccdt 新建一个，或用 ccdt -r --all 从全部会话里选。'),
          1
        );
      }
      const chosen = await pick(
        values.all ? '选择会话：' : `选择 ${here} 的会话：`,
        sessions.map(
          (other) =>
            `${when(other.updatedAt).padEnd(12)} ${other.title}${status(other)}${values.all ? dim(`  ${other.projectPath}`) : ''}`,
        ),
      );
      if (chosen === undefined) {
        await service.close();
        return 0;
      }
      session = sessions[chosen];
    } else if (command !== 'new' && mine.length) session = newest(mine)[0];
    else {
      const response = await service.request({
        type: 'session.create',
        title: (rest.join(' ') || basename(here) || here).slice(0, 120),
        projectPath: here,
      });
      session = service.sessions.get(response.sessionId) ?? {
        id: response.sessionId,
        title: rest.join(' ') || basename(here),
        projectPath: here,
      };
      fresh = true;
    }
    return await show(config, values, service, session, fresh);
  } catch (error) {
    await service?.close().catch(() => {});
    say(error instanceof Error ? error.message : String(error));
    // ccdt speaks the protocol of its own release, as the desktop client does.
    if (error.code === 'version_mismatch' && error.service)
      say(
        `这个 ccdt 是 ${version}，服务端是 ${error.service}：运行 ccdt upgrade 升级，或安装与服务端相同版本的 ccdt：${releasePage(error.service)}`,
      );
    return 1;
  }
}
