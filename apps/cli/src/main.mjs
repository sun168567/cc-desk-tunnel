import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Config } from './config.mjs';
import { Service } from './connection.mjs';
import { discard, protect, reveal } from './secret.mjs';
import { relay } from './terminal.mjs';

const HELP = `ccdt：在自己的终端里使用 CC Desk Tunnel 服务端上的原版 Claude Code。

用法：
  ccdt                     接着当前目录这个项目最近的会话；没有就新建
  ccdt new [标题]          在当前目录新建会话
  ccdt open <会话 ID>      打开一个会话（ID 可只写开头几位）
  ccdt sessions [--all]    列出当前目录的会话；--all 列出全部
  ccdt usage               调用统计与订阅额度
  ccdt login <wss 地址>    登录服务端；--fingerprint 证书指纹，--token-stdin 从标准输入读凭据，--no-save 不保存
  ccdt logout              退出当前服务端

选项：--server <wss 地址> 选择已登录的服务端。

在会话里按 Ctrl+Q 回到这里，Claude Code 留在服务端继续运行，再次打开时接着显示。退出 Claude Code（/exit）
就结束这个终端。终端里聊的内容在结束后记入这个会话，图形客户端里也能看到。`;

const write = (text) => process.stderr.write(`${text}\n`);

// The session's project directory as the desktop client records it, compared without the case on Windows.
const sameDirectory = (a, b) => {
  const normal = (path) => resolve(path).replace(/[\\/]+$/, '');
  return process.platform === 'win32'
    ? normal(a).toLowerCase() === normal(b).toLowerCase()
    : normal(a) === normal(b);
};

async function readSecret(prompt) {
  const input = process.stdin;
  if (!input.isTTY) {
    let text = '';
    for await (const chunk of input) text += chunk;
    return text.trim();
  }
  process.stderr.write(prompt);
  input.setRawMode(true);
  input.setEncoding('utf8');
  let text = '';
  try {
    for await (const chunk of input) {
      for (const key of chunk) {
        if (key === '\r' || key === '\n') return text;
        if (key === '\u0003') throw Object.assign(new Error('已取消。'), { code: 'cancelled' });
        text = key === '\u007f' || key === '\b' ? text.slice(0, -1) : text + key;
      }
    }
    return text;
  } finally {
    input.setRawMode(false);
    input.pause();
    process.stderr.write('\n');
  }
}

async function signIn(config, values) {
  const server = config.server(values.server);
  if (!server) throw new Error('还没有登录服务端：先运行 ccdt login <wss 地址>。');
  const token = process.env.CCDT_TOKEN || reveal(server.url, server.token);
  if (!token)
    throw new Error('没有保存这个服务端的凭据：运行 ccdt login 重新登录，或设置 CCDT_TOKEN。');
  return Service.connect({ ...server, token, deviceId: config.device() });
}

async function login(config, values, url) {
  if (!url) throw new Error('用法：ccdt login <wss 地址>');
  const token = values['token-stdin']
    ? (await readSecret('')).trim()
    : process.env.CCDT_TOKEN || (await readSecret('服务凭据（不回显）：'));
  const server = { url, fingerprint: values.fingerprint ?? '' };
  const service = await Service.connect({ ...server, token, deviceId: config.device() });
  write(`已连接 ${url}（服务端 ${service.version}）。`);
  await service.close();
  const previous = config.server(url);
  if (previous) discard(previous.url, previous.token);
  config.remember(values['no-save'] ? server : { ...server, token: protect(url, token) });
  write(values['no-save'] ? '未保存凭据；之后用 CCDT_TOKEN 提供。' : '已保存。');
}

function listed(sessions) {
  return sessions
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((session) => {
      const busy = session.activeRun
        ? session.activeRun.surface === 'terminal'
          ? ' [终端]'
          : ' [运行中]'
        : '';
      return `${session.id.slice(0, 8)}  ${session.updatedAt.slice(0, 16).replace('T', ' ')}  ${session.title}${busy}${'\n'}          ${session.projectPath}${session.device ? `（${session.device.name}）` : ''}`;
    })
    .join('\n');
}

// Shows the session's terminal, and takes it up again after the connection is lost.
async function show(config, values, service, sessionId) {
  for (;;) {
    await service.channel();
    const result = await relay(service, sessionId);
    if (result.how === 'exited') {
      await service.close();
      return result.code ?? 0;
    }
    if (result.how !== 'lost') {
      write(result.how === 'taken' ? '另一个连接打开了这个终端。' : '终端留在服务端继续运行。');
      await service.close(false);
      return 0;
    }
    write('连接断开，正在重连……（Ctrl+C 放弃，终端在服务端保留）');
    for (let wait = 1000; ; wait = Math.min(wait * 2, 15000)) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      try {
        service = await signIn(config, values);
        break;
      } catch (error) {
        if (error.code === 'unauthorized' || error.code === 'version_mismatch') throw error;
      }
    }
  }
}

export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      server: { type: 'string' },
      fingerprint: { type: 'string' },
      'token-stdin': { type: 'boolean' },
      'no-save': { type: 'boolean' },
      all: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;
  const config = new Config();
  try {
    if (values.help || command === 'help') return (write(HELP), 0);
    if (command === 'login') return (await login(config, values, rest[0]), 0);
    if (command === 'logout') {
      const server = config.server(values.server);
      if (!server) return (write('没有登录任何服务端。'), 0);
      discard(server.url, server.token);
      config.forget(server.url);
      return (write(`已退出 ${server.url}。`), 0);
    }
    if (command && !['new', 'open', 'sessions', 'usage'].includes(command))
      return (write(`未知命令：${command}\n\n${HELP}`), 2);
    const service = await signIn(config, values);
    const here = process.cwd();
    const mine = [...service.sessions.values()].filter((session) =>
      sameDirectory(session.projectPath, here),
    );
    if (command === 'sessions') {
      const sessions = values.all ? [...service.sessions.values()] : mine;
      write(sessions.length ? listed(sessions) : '没有会话。');
      await service.close(false);
      return 0;
    }
    if (command === 'usage') {
      const summary = await service.request({ type: 'usage.summary' });
      const { type: _type, requestId: _id, ...figures } = summary;
      process.stdout.write(`${JSON.stringify(figures, null, 2)}\n`);
      await service.close(false);
      return 0;
    }
    let sessionId;
    if (command === 'open') {
      const prefix = rest[0]?.toLowerCase();
      const found = prefix
        ? [...service.sessions.values()].filter((session) => session.id.startsWith(prefix))
        : [];
      if (found.length !== 1) {
        await service.close(false);
        return (write(found.length ? '有多个会话以此开头，请多写几位。' : '没有这个会话。'), 1);
      }
      sessionId = found[0].id;
    } else if (command !== 'new' && mine.length)
      sessionId = mine.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0].id;
    else {
      const response = await service.request({
        type: 'session.create',
        title: (rest.join(' ') || basename(here) || here).slice(0, 120),
        projectPath: here,
      });
      sessionId = response.sessionId;
    }
    return await show(config, values, service, sessionId);
  } catch (error) {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
