import { appendFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { FORCED_UPGRADE_SINCE } from '@cc-desk-tunnel/protocol';
import { upgradeService } from '../../desktop/electron/service-upgrade.mjs';
import { Config, hostOf, sameService, serviceKey } from './config.mjs';
import { Service, proxyFor } from './connection.mjs';
import { readKeys } from './keys.mjs';
import { pad, pick } from './picker.mjs';
import { choices, entries, parse, readRemote, save, shown } from './settings.mjs';
import { discard, protect, reveal } from './secret.mjs';
import { bundled, releasePage, version } from './runtime.mjs';
import { relay } from './terminal.mjs';
import { markOnline, onlineAt, stayOnline } from './online.mjs';
import { FIRST_UPGRADABLE, download, install } from './upgrade.mjs';
import { EXIT } from './agent.mjs';
import { serveAcp } from './acp.mjs';
import {
  answer,
  approve,
  deny,
  logs,
  printTask,
  status as statusOf,
  stop,
  tell,
  wait,
} from './tasks.mjs';
import { UPDATE_TICK_MS, lookDue } from '../../desktop/src/update-check.ts';

const HELP = `ccdt：在自己的终端里使用 CC Desk Tunnel 服务端上的原版 Claude Code，与图形客户端共用会话。

用法：
  ccdt                   接着当前目录这个项目最近的会话；没有就新建
  ccdt -r                从当前项目的会话里选一个打开（加 --all 从全部会话里选）
  ccdt new [标题]        在当前目录新建会话
  ccdt sessions [--all]  列出当前项目的会话；--all 列出全部；--json 输出 JSON
  ccdt online            不开终端，让这台电脑保持在线，Claude 可以在这里执行命令；
                         断线自动重连，Ctrl+C 结束。无图形界面的服务器上可放到后台运行
  ccdt usage             订阅额度与调用统计
  ccdt config            查看和修改设置：在终端里用方向键逐项选择
  ccdt config 名称 [值]  查看或修改一项，供脚本使用；值写 default 恢复默认
  ccdt server            已登录的服务端：选一个作为默认连接的，或登录新的
  ccdt login [wss 地址]  登录服务端；不写地址时从图形客户端保存的里选。--fingerprint 证书指纹，
                         --token-stdin 从标准输入读凭据，--no-save 不保存，
                         --no-verify 不连接验证、只保存（图形客户端交给 ccdt 已在用的凭据时用）
  ccdt logout            退出一个服务端（登录了几个时先选），其他的不受影响
  ccdt open <会话 ID>    按 ID 打开（ID 可只写开头几位），供脚本使用
  ccdt upgrade [--yes]   升级服务端（升级前会问；--yes 不问），再把 ccdt 换成与服务端相同的版本；
                         有会话正在运行时会说明，可以选择强行升级（--force 不问）
  ccdt upgrade --check   只检查有没有新版本
  ccdt --version         版本，须与服务端相同

供程序和其他 agent 使用（写法同 claude -p；详见 ccdt help agents）：
  ccdt -p "任务"         在当前目录的项目里新建会话、发出任务，这一轮结束后输出 Claude 的回复
                         -c 接最近的会话，-r <会话> 接指定的会话，--bg 发出后立即返回
  ccdt status <会话>     在做什么、在等什么
  ccdt tell <会话> "…"   追加指示：运行中就加进正在进行的这一轮
  ccdt wait <会话>       等到这一轮结束，或 Claude 等人批准、回答
  ccdt approve|deny <会话>  批准或拒绝 Claude 等待的请求；ccdt answer <会话> "答案" 回答它的提问
  ccdt logs <会话>       最近的对话和工具调用
  ccdt stop <会话>       停止正在进行的这一轮
  ccdt acp               作为 ACP（Agent Client Protocol）agent 运行，供 Zed、JetBrains、acpx 等接入

选项：
  -s                     先选服务端，再做后面的事，如 ccdt -s -r
  --server <名称>        直接指定服务端：图形客户端里的连接名、主机名或地址，写出能区分的一段即可
不指定时连接上一次连接的服务端。

用法和本地的 claude 一样：窗口开着它就一直运行，断网会自动接回；退出 Claude Code 或关掉窗口就结束。
终端里聊的内容会记入这个会话，图形客户端里也能看到。`;

export const AGENT_HELP = `ccdt 供程序和其他 agent 使用：把任务交给服务端上的 Claude Code，跟进到它完成。
会话和图形客户端里的是同一个：窗口里能看到它在做什么，也能插话、批准。

派发（写法同 claude -p）：
  ccdt -p "任务" [选项]
    默认在当前目录的项目里新建会话；-c 接这个项目最近的会话；-r <会话> 接指定会话
    --bg                    发出后立即返回会话 ID，不等结果
    --output-format text|json|stream-json   默认 text：只输出 Claude 最后的回复
    --permission-mode auto|default|plan|acceptEdits|bypassPermissions
    --model <模型>  --effort low|medium|high|xhigh|max  --title <标题>
    --timeout <秒>          最多等这么久；到时仍在运行就返回（退出码 6）
  任务也可以从标准输入传入：echo "任务" | ccdt -p

跟进（<会话> 写会话 ID，可只写开头几位）：
  ccdt status <会话> [--json]     在做什么、在等什么
  ccdt wait <会话> [--timeout 秒] [--output-format …]   等到这一轮结束或需要人处理
  ccdt tell <会话> "补充"          追加指示；Claude 正在做时加进这一轮，用来中途纠偏
  ccdt approve <会话> [--mode auto|acceptEdits|default]   批准请求；--mode 只用于计划
  ccdt deny <会话> ["意见"]        拒绝；对计划，意见是让它怎么改
  ccdt answer <会话> "答案1" ["答案2" …]   按顺序回答 Claude 的提问；多选用逗号隔开
  ccdt logs <会话> [--last N] [--json]   最近 N 条（默认 20）对话和工具调用
  ccdt stop <会话>                停止这一轮
  ccdt sessions [--all] --json    列出会话

ACP：会说 Agent Client Protocol 的编辑器和 agent（Zed、JetBrains、acpx 等）把 ccdt acp 配成 agent 命令即可，
会话就在启动它的目录对应的项目里。

退出码：0 完成（或 --bg 已发出）；2 在等批准或回答；3 失败；4 已停止；5 连不上或未登录；
6 到 --timeout 时仍在运行；1 其他错误。结果在标准输出，说明和下一步该怎么做在标准错误。

json 结果：{"session_id","state","result","is_error","approval"?}。state 为 completed、background（这一轮
结束，后台任务还在运行，完成后 Claude 会自动接着做）、awaiting_approval、awaiting_answer、failed、cancelled
或 running。approval 说明在等什么：{"kind":"tool","tool","input","reason"?}、{"kind":"plan","plan"}
或 {"kind":"question","questions":[{"question","options","multiSelect"}]}。

审批：Claude 请求批准或提问时，ccdt -p 和 ccdt wait 停下来，交给调用方用 approve、deny、answer 处理；
图形客户端里同时也能处理，谁先回答算谁的。要少被问，派发时带 --permission-mode。

用法提示：
- 任务长时，把 ccdt -p 放进你自己的后台任务里跑，它结束时你就会得知；或用 --bg 发出，之后 ccdt wait。
- Claude 在哪台电脑上执行命令：会话所在的那台，新建的会话就是运行 ccdt 的这台。
  ccdt -p 等待期间自己提供这台电脑的执行通道；用 --bg 发出后，要有图形客户端或 ccdt online 开着。`;

const say = (text) => process.stderr.write(`${text}\n`);
// `CCDT_LOG` names a file for what the connection did, for finding out why it failed.
const log = (line) => {
  if (process.env.CCDT_LOG)
    appendFileSync(process.env.CCDT_LOG, `${new Date().toISOString()} ${line}\n`);
};
const dim = (text) => (process.stderr.isTTY ? `\x1b[2m${text}\x1b[0m` : text);
const notice = (text) => (process.stderr.isTTY ? `\x1b[33m${text}\x1b[0m` : text);
// What the service last found of a newer release, said before the terminal is shown and after it ends: the screen
// in between is Claude Code's own.
const newer = (update) =>
  update?.state === 'available'
    ? `服务端有新版本 ${update.latest}：运行 ccdt upgrade 升级服务端和 ccdt。`
    : update?.state === 'manual'
      ? `服务端有新版本 ${update.latest}，要在服务器上重新运行安装命令升级。`
      : undefined;

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
// Who is using the session now: a terminal of ccdt, which reports what its CLI is doing, or a run started from the
// desktop client.
const TERMINAL = { working: '终端运行中', waiting: '终端等你确认', idle: '终端打开中' };
const using = (run) =>
  run.surface !== 'terminal' ? '图形客户端运行中' : (TERMINAL[run.activity] ?? TERMINAL.idle);
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

// A line typed in, shown as it is typed and starting from `text`; Esc gives up (undefined).
async function readLine(prompt, text = '') {
  const draw = () => process.stderr.write(`\r\x1b[K${prompt}${text}`);
  draw();
  try {
    const line = await readKeys(process.stdin, (chunk) => {
      if (chunk === '\x1b') return null;
      // Arrows and other keys that send a sequence change nothing here.
      if (chunk.startsWith('\x1b')) return undefined;
      for (const key of chunk) {
        if (key === '\r' || key === '\n') return text;
        if (key === '\u0003') return null;
        if (key === '\u007f' || key === '\b') text = [...text].slice(0, -1).join('');
        else if (key >= ' ') text += key;
      }
      draw();
    });
    return line ?? undefined;
  } finally {
    process.stderr.write('\n');
  }
}

// What a service is called here: the desktop client's name for the connection to it, else its host.
const called = (server, names) => names.get(serviceKey(server.url)) ?? hostOf(server.url);
// The services signed in to, the one connected to last first, each line its name, when it was last used and its
// address; the one used when none is named is marked.
function serverLines(config, names) {
  const servers = config.servers.toSorted((a, b) => (b.usedAt ?? '').localeCompare(a.usedAt ?? ''));
  return {
    servers,
    lines: servers.map(
      (server) =>
        `${pad(called(server, names), 18)}${pad(server.usedAt ? when(server.usedAt) : '', 14)}${dim(server.url)}${sameService(server.url, config.server()?.url) ? '  （当前）' : ''}`,
    ),
  };
}

// The service a command goes to: the one `--server` names, one chosen with -s, else the one connected to last. It is
// chosen once and kept in `values`, for connecting again after a lost connection to go back to it.
async function target(config, values) {
  if (!config.servers.length) {
    if (values.server || !process.stdin.isTTY)
      throw new Error('还没有登录服务端：先运行 ccdt login。');
    say('还没有登录服务端，先登录一个。');
    await login(config, values);
  }
  const names = config.names();
  let server = config.server();
  if (values.server) {
    const found = config.find(values.server, names);
    if (found.length > 1)
      throw new Error(
        `有几个服务端都符合 ${values.server}：${found.map((other) => called(other, names)).join('、')}，请写得更具体。`,
      );
    if (!found.length)
      throw new Error(
        `没有登录过 ${values.server}：运行 ccdt server 查看已登录的服务端，或运行 ccdt login 登录。`,
      );
    server = found[0];
  } else if (values.select) {
    if (!process.stdin.isTTY) throw new Error('选服务端需要在终端里运行；也可以用 --server 指定。');
    const { servers, lines } = serverLines(config, names);
    const chosen = await pick('连接哪个服务端：', lines, process.stdin, process.stderr, {
      at: servers.indexOf(server),
      hint: '↑↓ 选择 · Enter 连接 · Esc 取消',
      clear: true,
    });
    if (chosen === undefined) throw new Error('已取消。');
    server = servers[chosen];
  }
  values.server = server.url;
  values.select = false;
  return server;
}

function credentials(server) {
  const token = process.env.CCDT_TOKEN || reveal(server.url, server.token);
  if (!token)
    throw new Error('没有保存这个服务端的凭据：运行 ccdt login 重新登录，或设置 CCDT_TOKEN。');
  return token;
}

// Where `ccdt online` of this computer says it is online, and for which service.
const onlinePath = (config) => join(config.paths.cli, 'online.json');
// A service connected to becomes the one used when none is named. The connection opens an execution channel for
// Claude's commands as `tunnel` says; by default it does unless `ccdt online` carries this computer's already.
async function signIn(config, values, quiet = false, tunnel = undefined) {
  const server = await target(config, values);
  const token = credentials(server);
  if (!quiet) say(dim(`正在连接 ${called(server, config.names())} ……`));
  const service = await Service.connect({
    ...server,
    token,
    deviceId: config.device(),
    waits: config.waits,
    tunnel: tunnel ?? !onlineAt(onlinePath(config), server.url),
    log,
  });
  config.use(server.url);
  return service;
}

// `ccdt server`: the services signed in to; the one chosen is connected to when none is named.
async function chooseServer(config, values) {
  const names = config.names();
  const { servers, lines } = serverLines(config, names);
  if (!process.stdin.isTTY) return (say(lines.join('\n') || '还没有登录服务端。'), 0);
  const chosen = await pick(
    '已登录的服务端：',
    [...lines, '登录新的服务端…'],
    process.stdin,
    process.stderr,
    {
      at: Math.max(0, servers.indexOf(config.server())),
      hint: '↑↓ 选择 · Enter 设为默认 · Esc 退出',
    },
  );
  if (chosen === undefined) return 0;
  if (chosen === servers.length) return (await login(config, values), 0);
  config.use(servers[chosen].url, false);
  say(`之后默认连接 ${called(servers[chosen], names)}。`);
  return 0;
}

async function logout(config, values) {
  if (!config.servers.length) return (say('没有登录任何服务端。'), 0);
  values.select ||= !values.server && config.servers.length > 1 && process.stdin.isTTY;
  const server = await target(config, values);
  discard(server.url, server.token);
  config.forget(server.url);
  say(`已退出 ${called(server, config.names())}。`);
  return 0;
}

// Without an address the service is one of the desktop client's, or one typed in.
async function login(config, values, url) {
  let server = url ? { url, fingerprint: values.fingerprint ?? '' } : undefined;
  if (!server) {
    const saved = config.desktopLogins();
    let chosen = saved.length === 1 ? 0 : undefined;
    if (process.stdin.isTTY) {
      chosen = await pick(
        '登录哪个服务端：',
        [
          ...saved.map(
            (login) =>
              `${pad(login.name, 18)}${dim(login.url)}${config.servers.some((server) => sameService(server.url, login.url)) ? '  （已登录）' : ''}`,
          ),
          '输入其他地址…',
        ],
        process.stdin,
        process.stderr,
        { hint: '↑↓ 选择 · Enter 登录 · Esc 取消', clear: true },
      );
      if (chosen === undefined) throw new Error('已取消。');
    }
    if (chosen === undefined)
      throw new Error('用法：ccdt login <wss 地址> [--fingerprint 证书指纹]');
    if (chosen < saved.length) {
      server = {
        url: saved[chosen].url,
        fingerprint: values.fingerprint ?? saved[chosen].fingerprint,
      };
      say(`服务端：${saved[chosen].name}（${server.url}，取自图形客户端）`);
    } else {
      const typed = (await readLine('服务端地址（wss://…）：'))?.trim();
      if (!typed) throw new Error('已取消。');
      server = { url: typed, fingerprint: values.fingerprint ?? '' };
    }
  }
  const token = values['token-stdin']
    ? await readSecret('')
    : process.env.CCDT_TOKEN ||
      (await readSecret('服务凭据（与图形客户端填的相同，输入时不显示）：'));
  // A token the desktop client is connected with right now has been checked: connecting again only to check it
  // would hold up the terminal it is handed over for (see the desktop's ccdt.mjs).
  if (values['no-verify']) say(`已登录 ${server.url}。`);
  else {
    say(dim('正在验证……'));
    const service = await Service.connect({
      ...server,
      token,
      deviceId: config.device(),
      waits: config.waits,
      // Checking the token runs no command on this computer.
      tunnel: false,
    });
    say(`已登录 ${server.url}（服务端版本 ${service.version}）。`);
    say(dim('不开终端、让这台电脑一直在线：ccdt online'));
    await service.close();
  }
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
  const server = await target(config, values);
  const token = credentials(server);
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
  let next = current;
  // A service newer than ccdt is not asked: this ccdt cannot tell which protocol it speaks.
  if (!older(version, current)) {
    say(dim(`服务端是 ${current}，正在检查新版本……`));
    let installing = false;
    // Sessions at work hold the upgrade back; a service that can be forced past them is, when asked to.
    const forcible = !older(current, FORCED_UPGRADE_SINCE);
    const attempt = (force) =>
      upgradeService(
        {
          url: server.url,
          fingerprint: server.fingerprint,
          token,
          deviceName: hostname(),
          service: current,
          force,
        },
        {
          resolveProxy: async (address) => proxyFor(address),
          confirm: async (latest) => {
            if (values.yes || force) return true;
            if (!process.stdin.isTTY)
              throw new Error('升级服务端要先确认：在终端里运行 ccdt upgrade，或加 --yes。');
            return (
              (await pick(
                `服务端有新版本 ${latest}（现在是 ${current}）。升级时服务端会重启，正在运行的会话要先结束。`,
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
    try {
      try {
        next = await attempt(forcible && values.force);
      } catch (error) {
        if (error.code !== 'busy' || !forcible) throw error;
        if (!process.stdin.isTTY) throw new Error(`${error.message}强行升级：加 --force。`);
        if ((await pick(error.message, ['强行升级（正在运行的会被中断）', '不升级'])) !== 0)
          throw Object.assign(new Error('没有升级服务端。'), { code: 'declined' });
        next = await attempt(true);
      }
      say(`服务端已升级到 ${next}，正在重启，约一分钟后可以连接。`);
    } catch (error) {
      if (error.code === 'current') say(`服务端已是最新的正式版本 ${current}。`);
      else if (error.code === 'declined' || error.code === 'manual') say(error.message);
      else throw error;
    }
  }
  if (next === version) {
    say(`ccdt 是 ${version}，与服务端相同。`);
    return 0;
  }
  if (older(next, FIRST_UPGRADABLE)) {
    say(
      `ccdt 不能自己换成 ${FIRST_UPGRADABLE} 以前的版本：到 ${releasePage(next)} 下载 ccdt ${next}，运行其中的安装脚本。`,
    );
    return 1;
  }
  if (!bundled) {
    say(`从源码运行的 ccdt 不自行更新：服务端是 ${next}，请换到这个版本的源码。`);
    return 1;
  }
  say(dim(`正在下载 ccdt ${next}……`));
  install(await download(next));
  say(`ccdt 已换成 ${next}。`);
  say(dim('其他已打开的 ccdt 窗口仍是原来的版本，关掉重开即可。'));
  return 0;
}

// Asks the service to look for a newer release now and says what it found, for both sides.
async function check(config, values) {
  const service = await signIn(config, values, true, false);
  try {
    await service.request({ type: 'service.update.check' });
  } finally {
    await service.close();
  }
  const { update } = service;
  if (update?.state === 'failed') return (say(`检查新版本失败：${update.detail ?? '原因不明'}`), 1);
  const found = newer(update);
  say(
    found
      ? `服务端和 ccdt 现在是 ${version}。${found}`
      : `服务端和 ccdt 都是 ${version}，已是最新的正式版本。`,
  );
  return 0;
}

// `ccdt config`: every setting with its value; with a name, that one; with a value too, sets it. In a terminal and
// without a name the list is gone through with the arrow keys, each value chosen or typed there.
async function configure(config, values, [name, ...words]) {
  let service;
  let remote = {};
  // This computer's own settings need no service; the others are read from it.
  if (!name?.startsWith('connection.'))
    try {
      // Settings are no reason to log in: without a service only this computer's are shown.
      if (!config.servers.length) throw new Error('还没有登录服务端');
      service = await signIn(config, values, true, false);
      remote = await readRemote(service);
    } catch (error) {
      if (name) throw error;
      say(dim(`连不上服务端，只能改本机的设置：${error.message}`));
    }
  const list = () => entries({ waits: config.waits, ...remote });
  try {
    if (name) {
      const entry = list().find((item) => item.name === name);
      if (!entry) throw new Error(`没有这个设置：${name}。运行 ccdt config 查看全部。`);
      if (!words.length) {
        say(described(entry));
        return 0;
      }
      const value = parse(entry, words.join(' '));
      await save(entry, value, { config, service });
      say(`${entry.title}：${shown({ ...entry, value })}`);
      return 0;
    }
    if (!process.stdin.isTTY) {
      say(table(list()));
      return 0;
    }
    for (let at = 0; ;) {
      const all = list();
      const chosen = await pick(
        'ccdt 设置',
        all.map((entry) => `${pad(entry.title, 34)}${pad(shown(entry), 18)}${dim(entry.group)}`),
        process.stdin,
        process.stderr,
        { at, hint: '↑↓ 选择 · Enter 修改 · Esc 退出', clear: true },
      );
      if (chosen === undefined) return 0;
      at = chosen;
      const entry = all[chosen];
      if (entry.kind === 'pending') {
        say(`${entry.title}暂不支持在 ccdt 里设置：${entry.where}`);
        continue;
      }
      let value;
      const options = choices(entry);
      if (options) {
        const index = await pick(
          `${entry.title}${entry.detail ? dim(`  ${entry.detail}`) : ''}`,
          options.map(([, words]) => words),
          process.stdin,
          process.stderr,
          {
            at: Math.max(
              0,
              options.findIndex(([option]) => option === (entry.value ?? null)),
            ),
            hint: '↑↓ 选择 · Enter 确定 · Esc 返回',
            clear: true,
          },
        );
        if (index === undefined) continue;
        value = options[index][0];
      } else {
        if (entry.detail) say(dim(entry.detail));
        const typed = await readLine(
          `${entry.title}（写 default 恢复默认，Esc 返回）：`,
          entry.kind === 'seconds' ? String(entry.value ?? '') : entry.write(entry.value),
        );
        // The question goes from the screen once answered, as the lists do.
        process.stderr.write(`\x1b[${entry.detail ? 2 : 1}A\x1b[J`);
        if (typed === undefined) continue;
        try {
          value = parse(entry, typed);
        } catch (error) {
          say(error.message);
          continue;
        }
      }
      try {
        await save(entry, value, { config, service });
        if (service && !entry.name.startsWith('connection.')) remote = await readRemote(service);
      } catch (error) {
        say(`没有保存：${error.message}`);
      }
    }
  } finally {
    await service?.close().catch(() => {});
  }
}

// One setting, for `ccdt config <name>`: its value, what it does and what it can be.
function described(entry) {
  const options = choices(entry);
  return [
    `${entry.title}：${shown(entry)}`,
    entry.detail && dim(entry.detail),
    entry.kind === 'pending' && entry.where,
    options &&
      `可选：${options.map(([value, words]) => `${value === null ? 'default' : typeof value === 'boolean' ? (value ? 'on' : 'off') : value}（${words}）`).join('、')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// Every setting by its group, with the name to change it by.
function table(list) {
  const lines = [];
  for (const entry of list) {
    if (entry.group !== lines.group)
      lines.push(`${lines.length ? '\n' : ''}${(lines.group = entry.group)}`);
    lines.push(`  ${entry.name.padEnd(34)} ${entry.title}：${shown(entry)}`);
  }
  return [...lines, '', dim('改一项：ccdt config <名称> <值>；值写 default 恢复默认。')].join('\n');
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
  if (newer(service.update)) say(notice(newer(service.update)));
  // A terminal of ccdt is taken over; a run from the desktop client has to finish first.
  const run = service.sessions.get(session.id)?.activeRun;
  if (run && run.surface !== 'terminal') {
    await service.close();
    say('这个会话正在图形客户端里运行，这一轮结束后再打开。');
    return 1;
  }
  // While the terminal is shown the service looks for a new release at least hourly, as for a desktop window in use;
  // what it finds is said when the terminal ends.
  const look = () => {
    if (lookDue(service.update, Date.now()))
      void service.request({ type: 'service.update.check' }).catch(() => {});
  };
  look();
  const looking = setInterval(look, UPDATE_TICK_MS);
  looking.unref();
  try {
    return await showing();
  } finally {
    clearInterval(looking);
  }
  async function showing() {
    for (;;) {
      let result;
      let unwatch;
      try {
        if (service.tunnel) await service.channel();
        else
          try {
            // `ccdt online` carries this computer's commands; where it no longer does, this window opens a channel.
            await service.channel(5000);
          } catch (error) {
            if (service.ended) throw error;
            await service.close().catch(() => {});
            service = await signIn(config, values, true, true);
            await service.channel();
          }
        unwatch = service.tunnel ? undefined : shared(service);
        result = await relay(service, session.id, shown);
      } catch (error) {
        // Nothing to show, such as a terminal the service would not open: the connection is let go, for ccdt to end.
        await service.close().catch(() => {});
        throw error;
      }
      unwatch?.();
      log(`Terminal shown no longer: ${result.how}.`);
      if (result.how === 'exited') {
        await service.close();
        say(dim('已退出。对话记录在这个会话里，在这个目录运行 ccdt 可以接着聊。'));
        if (newer(service.update)) say(notice(newer(service.update)));
        return result.code ?? 0;
      }
      if (result.how === 'taken') {
        await service.close();
        say('这个会话在另一个窗口里打开了，这里不再显示。');
        return 0;
      }
      if (result.how === 'stalled') continue;
      // Let go for `ccdt online` gone: signed in again at once, with a channel of its own.
      const handover = service.handover;
      if (!handover) {
        process.stdout.write('\x1b]0;ccdt：连接断开，正在重连\x07');
        say(dim('\r\n连接断开，正在重连……Claude Code 在服务端继续运行。'));
      }
      for (let wait = handover ? 0 : 1000; ; wait = Math.min(Math.max(wait * 2, 1000), 15000)) {
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
}

// Commands reach this computer by `ccdt online` while it is there. Where they have not for a few seconds, the
// connection is let go (`handover`), for the window to sign in again with a channel of its own.
function shared(service) {
  let timer;
  const check = (message) => {
    if (message.type !== 'devices') return;
    if (message.devices.some((device) => device.id === service.deviceId && device.ready)) {
      clearTimeout(timer);
      timer = undefined;
    } else
      timer ??= setTimeout(() => {
        service.handover = true;
        service.end(true);
      }, 5000);
  };
  service.on('message', check);
  return () => {
    clearTimeout(timer);
    service.off('message', check);
  };
}

// With -p, -r takes a session as claude -p's does, where alone it opens the list to choose from.
function printing(argv) {
  if (!argv.some((arg) => arg === '-p' || arg === '--print')) return argv;
  const args = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if ((arg === '-r' || arg === '--resume') && argv[index + 1] && !argv[index + 1].startsWith('-'))
      args.push('--session', argv[++index]);
    else args.push(arg);
  }
  return args;
}

const AGENT_COMMANDS = { status: statusOf, tell, wait, logs, stop, approve, deny, answer };

// What the commands for programs need of ccdt: a quiet sign-in, and this computer's execution channel kept for a run
// on it while they wait.
function agentContext(config, values) {
  const here = process.cwd();
  const deviceId = config.device();
  const online = () => !!values.server && onlineAt(onlinePath(config), values.server);
  return {
    here,
    version,
    out: (text) => process.stdout.write(`${text}\n`),
    err: say,
    newest,
    mine: (session) => sameDirectory(session.projectPath, here),
    // Away from this computer the run needs nothing of this connection; here it needs a channel, ccdt online's
    // while that carries it.
    carried: (session) => (session.device && session.device.id !== deviceId) || online(),
    // Without `tunnel` a channel is opened as for a terminal: unless ccdt online carries this computer's.
    async connect(tunnel) {
      try {
        return await signIn(config, values, true, tunnel);
      } catch (error) {
        throw Object.assign(error, { exit: error.exit ?? EXIT.connection });
      }
    },
    async keep(service, session) {
      if (session.device && session.device.id !== deviceId) return service;
      if (service.tunnel) {
        await service.channel();
        return service;
      }
      try {
        await service.channel(5000);
        // Where ccdt online stops carrying it, the connection is let go, to be made again with a channel of its own.
        shared(service);
        return service;
      } catch (error) {
        if (service.ended && error.exit) throw error;
        await service.close().catch(() => {});
        const again = await this.connect(true);
        await again.channel();
        return again;
      }
    },
    release: (service) => service.close().catch(() => {}),
  };
}

async function agentCommand(config, values, command, rest) {
  const context = agentContext(config, values);
  if (values.print) {
    let prompt = [command, ...rest].filter((word) => word !== undefined).join(' ');
    if (!prompt.trim() && !process.stdin.isTTY) {
      for await (const chunk of process.stdin) prompt += chunk;
    }
    return await printTask(context, values, prompt);
  }
  const [ref, ...words] = rest;
  if (command === 'tell') return await tell(context, values, ref, words.join(' '));
  if (command === 'deny') return await deny(context, values, ref, words.join(' '));
  if (command === 'answer') return await answer(context, values, ref, words);
  return await AGENT_COMMANDS[command](context, values, ref);
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: printing(argv),
      allowPositionals: true,
      options: {
        resume: { type: 'boolean', short: 'r' },
        print: { type: 'boolean', short: 'p' },
        continue: { type: 'boolean', short: 'c' },
        session: { type: 'string' },
        bg: { type: 'boolean' },
        'output-format': { type: 'string' },
        'permission-mode': { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string' },
        title: { type: 'string' },
        timeout: { type: 'string' },
        last: { type: 'string' },
        mode: { type: 'string' },
        json: { type: 'boolean' },
        server: { type: 'string' },
        select: { type: 'boolean', short: 's' },
        fingerprint: { type: 'string' },
        'token-stdin': { type: 'boolean' },
        'no-save': { type: 'boolean' },
        'no-verify': { type: 'boolean' },
        all: { type: 'boolean' },
        check: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        force: { type: 'boolean' },
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
    if (command === 'help' && rest[0] === 'agents') return (say(AGENT_HELP), 0);
    if (values.help || command === 'help') return (say(HELP), 0);
    if (values.version) return (process.stdout.write(`ccdt ${version}\n`), 0);
    if (command === 'login') return (await login(config, values, rest[0]), 0);
    if (command === 'upgrade') return await (values.check ? check : upgrade)(config, values);
    if (command === 'config') return await configure(config, values, rest);
    if (command === 'logout') return await logout(config, values);
    if (command === 'server') return await chooseServer(config, values);
    if (command === 'online') {
      let ended;
      const stop = new Promise((resolve) => (ended = resolve));
      // A terminal closed ends ccdt as it would any program; started with nohup it is not told.
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => ended());
      const code = await stayOnline({
        connect: (again) => signIn(config, values, again, true),
        say,
        stop,
        mark: (on) => markOnline(onlinePath(config), config.current)(on),
      });
      process.exit(code);
    }
    if (command === 'acp') return await serveAcp(agentContext(config, values));
    if (values.print || AGENT_COMMANDS[command])
      return await agentCommand(config, values, command, rest);
    if (command && !['new', 'open', 'sessions', 'usage'].includes(command))
      return (say(`没有这个命令：${command}\n\n${HELP}`), 2);
    // Listing sessions and usage runs no command on this computer.
    service = await signIn(
      config,
      values,
      !!values.json,
      ['sessions', 'usage'].includes(command) ? false : undefined,
    );
    const here = process.cwd();
    const all = [...service.sessions.values()];
    const mine = all.filter((session) => sameDirectory(session.projectPath, here));
    if (command === 'sessions' && values.json) {
      process.stdout.write(
        `${JSON.stringify(
          newest(values.all ? all : mine).map((session) => ({
            session_id: session.id,
            title: session.title,
            project: session.projectPath,
            ...(session.device ? { device: session.device.name } : {}),
            state: !session.activeRun
              ? 'idle'
              : session.activeRun.surface === 'terminal'
                ? 'terminal'
                : session.activeRun.status === 'awaiting_approval'
                  ? 'awaiting_approval'
                  : session.activeRun.waiting === 'background'
                    ? 'background'
                    : 'running',
            updated_at: session.updatedAt,
          })),
        )}\n`,
      );
      await service.close();
      return 0;
    }
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
    if (error.exit !== undefined && error.code !== 'version_mismatch') return error.exit;
    // ccdt speaks the protocol of its own release, as the desktop client does. In a terminal it offers to become the
    // release of the service, or to upgrade the service first where ccdt is ahead of it.
    if (error.code === 'version_mismatch' && error.service) {
      if (process.stdin.isTTY && command !== 'upgrade') {
        const chosen = await pick(
          `这个 ccdt 是 ${version}，服务端是 ${error.service}，两边要同一版本才能连接。`,
          [
            older(version, error.service)
              ? `把 ccdt 换成 ${error.service}`
              : `升级服务端，再把 ccdt 换成同一版本`,
            '暂不升级',
          ],
        ).catch(() => undefined);
        if (chosen === 0)
          try {
            const code = await upgrade(config, values);
            if (!code) say('重新运行 ccdt 即可接着用。');
            return code;
          } catch (failure) {
            say(failure instanceof Error ? failure.message : String(failure));
            return 1;
          }
      }
      say(
        `这个 ccdt 是 ${version}，服务端是 ${error.service}：运行 ccdt upgrade 升级，或安装与服务端相同版本的 ccdt：${releasePage(error.service)}`,
      );
    }
    return 1;
  }
}
