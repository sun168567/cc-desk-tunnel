import { realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { effortSchema, permissionModeSchema } from '@cc-desk-tunnel/protocol';
import { controlTlsOptions, openProxyBridge } from '../../desktop/electron/proxy-bridge.mjs';
import { clearConfig, configDirectory, desktopLogin, loadConfig, saveConfig } from './config.mjs';
import { openConnection } from './connection.mjs';
import {
  daemonRunning,
  daemonSocket,
  daemonStatus,
  installDaemon,
  startDaemon,
  stopDaemon,
  uninstallDaemon,
} from './daemon.mjs';
import { environmentProxy } from './environment.mjs';
import manifest from '../package.json' with { type: 'json' };
import { Deck } from './deck.mjs';
import { attachTerminal, TERMINAL_RESET } from './terminal.mjs';

const USAGE = `用法：
  ccdt [目录]            在目录（默认当前目录）上打开远端原版 Claude Code
  ccdt deck [目录]       先打开 agent 列表
  ccdt daemon install    装成 systemd 用户服务：关掉终端 agent 也继续运行
  ccdt daemon status | stop | uninstall
  ccdt login             保存服务地址、证书指纹和服务凭据
  ccdt logout            删除保存的连接信息
  ccdt --help | --version

选项：
  -n, --new                      新建会话，而不是接着这个目录最近的对话
  -m, --model <模型>             会话模型
      --effort <强度>            low / medium / high / xhigh / max
      --permission-mode <模式>   auto / default / plan / acceptEdits

login 选项：--url <wss://…> --fingerprint <SHA256> --token-stdin（从标准输入读凭据）

在 Claude Code 里按 Ctrl+Q 回到 agent 列表，agent 在服务端继续运行；列表里可以进入、新建、结束
和搜索 agent，有 agent 等你时会响铃并显示在窗口标题上。后台服务运行时，退出 ccdt 或关掉终端
agent 照常运行，任何终端里再运行 ccdt 都能接回；没有后台服务时，退出 ccdt 会结束全部 agent。

环境变量：CCDT_TOKEN 覆盖保存的凭据；https_proxy / no_proxy 设定代理。
同一服务同时只接受一台执行设备；桌面客户端已连接时会提示忙。`;

const status = (text) => process.stderr.write(`\r\x1b[2K\x1b[2m${text}\x1b[0m`);
const clearStatus = () => process.stderr.write('\r\x1b[2K');

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        new: { type: 'boolean', short: 'n' },
        model: { type: 'string', short: 'm' },
        effort: { type: 'string' },
        'permission-mode': { type: 'string' },
        url: { type: 'string' },
        fingerprint: { type: 'string' },
        'token-stdin': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) return (console.log(USAGE), 0);
  if (values.version) return (console.log(manifest.version), 0);
  try {
    if (positionals[0] === 'login') return await login(values);
    if (positionals[0] === 'logout') {
      console.log((await clearConfig()) ? '已删除保存的连接信息。' : '没有保存的连接信息。');
      return 0;
    }
    if (positionals[0] === 'daemon') return await daemon(positionals[1]);
    const deck = positionals[0] === 'deck';
    if (deck) positionals.shift();
    if (positionals.length > 1) throw new UsageError('只能指定一个目录。');
    return await run(positionals[0] ?? '.', { ...values, deck });
  } catch (error) {
    clearStatus();
    console.error(
      error instanceof UsageError ? `${error.message}\n\n${USAGE}` : `ccdt：${error.message}`,
    );
    return error instanceof UsageError ? 2 : 1;
  }
}
class UsageError extends Error {}

function validate({ url, fingerprint, token }) {
  const address = new URL(url);
  if (
    address.protocol !== 'wss:' ||
    address.username ||
    address.password ||
    address.search ||
    address.hash
  )
    throw new Error('服务地址需要是不含凭据的 wss:// 地址。');
  controlTlsOptions({ fingerprint });
  if (token.length < 24) throw new Error('服务凭据至少 24 个字符。');
}

async function login(values) {
  const defaults = await desktopLogin();
  let { url, fingerprint } = values;
  let token = '';
  if (values['token-stdin']) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    token = Buffer.concat(chunks).toString('utf8').trim();
  }
  if (url === undefined || fingerprint === undefined || !token) {
    if (!process.stdin.isTTY)
      throw new Error('非交互使用时请提供 --url、--fingerprint 和 --token-stdin。');
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const ask = async (question, fallback) =>
        (
          await prompt.question(fallback ? `${question} [${fallback}]：` : `${question}：`)
        ).trim() || fallback;
      url ??= await ask('服务地址（wss://…）', defaults.url);
      fingerprint ??= await ask('证书 SHA256 指纹（留空用 CA 验证）', defaults.fingerprint);
    } finally {
      prompt.close();
    }
    token ||= await askSecret('服务凭据（不回显）：');
  }
  validate({ url, fingerprint, token });
  const where = await saveConfig({ url, fingerprint, token });
  console.log(
    where === 'keyring'
      ? '已保存。服务凭据存入系统密钥环。'
      : `已保存。系统密钥环不可用，服务凭据存入仅本用户可读的 ${configDirectory()}/cli.json。`,
  );
  console.log('Claude 账号登录在终端里用 /login 完成。');
  return 0;
}

// Reads a line from the terminal without echoing it.
function askSecret(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let text = '';
    process.stderr.write(question);
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    const done = (error) => {
      input.off('data', read);
      input.setRawMode(false);
      input.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(text.trim());
    };
    const read = (chunk) => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') return done();
        if (character === '\x03') return done(new Error('已取消。'));
        if (character === '\x7f' || character === '\b') text = text.slice(0, -1);
        else if (character >= ' ') text += character;
      }
    };
    input.on('data', read);
  });
}

async function daemon(command) {
  if (command === 'run') {
    const config = await loadConfig();
    if (!config?.token)
      throw new Error('没有可用的服务配置或凭据（密钥环可能已锁定）；请先运行 ccdt login。');
    const handle = await startDaemon({
      ...config,
      resolveProxy: async (target) => environmentProxy(target),
    });
    // systemd stops the daemon with SIGTERM; that ends the agents.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
      process.once(signal, () => void handle.stop().then(() => process.exit(0)));
    throw new Error((await handle.ended) ?? '与服务的连接已结束。');
  }
  if (command === 'install') {
    if (!(await loadConfig())?.token) throw new Error('请先运行 ccdt login。');
    const path = await installDaemon();
    console.log(`已安装并启动后台服务：${path}`);
    console.log('它运行的命令使用本终端此刻的 PATH；PATH 变了就再运行一次 ccdt daemon install。');
    console.log(
      '之后运行 ccdt 会连到它；关掉终端 agent 也继续运行。日志：journalctl --user -u ccdt',
    );
    console.log('桌面会话退出后也要保持运行，可以执行：loginctl enable-linger');
    return 0;
  }
  if (command === 'uninstall') {
    await uninstallDaemon();
    console.log('已停止并移除后台服务。');
    return 0;
  }
  if (command === 'stop') {
    await stopDaemon();
    console.log('后台服务已停止，它运行的 agent 都已结束；对话都保留。');
    return 0;
  }
  if (command === 'status') {
    const state = await daemonStatus();
    const answering = await daemonRunning();
    console.log(
      answering ? `后台服务运行中（${state}），${daemonSocket()}` : `后台服务未运行（${state}）。`,
    );
    return answering ? 0 : 3;
  }
  throw new UsageError('daemon 子命令：install / status / stop / uninstall / run');
}

async function run(directory, values) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('需要在交互式终端里运行。');
  const permissionMode = values['permission-mode'];
  if (permissionMode !== undefined && !permissionModeSchema.safeParse(permissionMode).success)
    throw new UsageError(`未知审批模式：${permissionMode}`);
  if (values.effort !== undefined && !effortSchema.safeParse(values.effort).success)
    throw new UsageError(`未知推理强度：${values.effort}`);
  const projectPath = await realpath(resolve(directory)).catch(() => {
    throw new Error(`目录不存在：${directory}`);
  });
  if (!(await stat(projectPath)).isDirectory()) throw new Error(`不是目录：${projectPath}`);
  // With the background daemon running, this ccdt is only a view: agents outlive it.
  const background = await daemonRunning();
  const config = await loadConfig();
  if (!background) {
    if (!config) throw new Error('尚未配置服务，请先运行 ccdt login。');
    if (!config.token)
      throw new Error('找不到服务凭据（密钥环可能已锁定）；请运行 ccdt login 或设置 CCDT_TOKEN。');
  }

  // Signals end ccdt: before the connection stands they stop the attempt; after, they close the connection, which
  // ends the agents (without the daemon) and lets the steps below clean up the terminal.
  const abort = new AbortController();
  let connection, bridge;
  const stop = () => (connection ? connection.close() : abort.abort());
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, stop);
  let deck;
  try {
    if (background) status('连接后台服务 …');
    else {
      status(`连接 ${new URL(config.url).host} …`);
      bridge = await openProxyBridge(
        { url: config.url, fingerprint: config.fingerprint },
        { resolveProxy: async (target) => environmentProxy(target) },
      );
      abort.signal.throwIfAborted();
      status('建立本机执行通道 …');
    }
    connection = await Promise.race([
      background
        ? openConnection(`ws+unix://${daemonSocket()}:/`, null)
        : openConnection(bridge.url, config.token),
      new Promise((_, reject) =>
        abort.signal.addEventListener('abort', () => reject(new Error('已取消。'))),
      ),
    ]);
    if (connection.ready.adapter !== 'claude-code')
      throw new Error('服务运行在离线模拟模式，没有原生终端。');
    let lost = null;
    connection.closed.then((reason) => (lost = reason ?? '连接已断开。'));
    deck = new Deck(connection, {
      cwd: projectPath,
      host: config?.url ? new URL(config.url).host : '',
      background,
    });
    await connection.request({ type: 'terminal.list' });
    let attached = false;
    // A network drop pauses everything until the bridge has the connection back. The list says so on its message
    // line; an agent's screen belongs to Claude Code, so there the window title does.
    connection.onState((state) => {
      const reconnecting = state === 'reconnecting';
      if (attached)
        process.stdout.write(`\x1b]2;${reconnecting ? 'ccdt：网络中断，正在重连…' : 'ccdt'}\x07`);
      else if (deck.shown) deck.notice(reconnecting ? '网络中断，正在重连…' : '已重新连接。');
      else status(reconnecting ? '网络中断，正在重连 …' : '已重新连接 …');
    });
    let next = null;
    if (!values.deck) {
      const session = await chooseSession(connection, projectPath, values);
      next = { sessionId: session.id, continued: !values.new };
    }
    clearStatus();
    let message = '';
    for (;;) {
      if (!next) {
        next = await deck.choose(message);
        if (next.lost) throw new Error(next.lost);
        if (next.quit) return 0;
      }
      const title = deck.sessions.get(next.sessionId)?.title ?? '';
      deck.attached = next.sessionId;
      attached = true;
      const terminal = attachTerminal(connection, next.sessionId, { continued: next.continued });
      let result;
      try {
        result = await terminal.exited;
      } catch (error) {
        if (lost) throw error;
        result = { error: error.message };
      } finally {
        attached = false;
        deck.attached = null;
        process.stdout.write(TERMINAL_RESET + '\x1b[H\x1b[2J');
      }
      message = result.error
        ? `无法打开「${title}」：${result.error}`
        : result.detached
          ? ''
          : `「${title}」已退出${result.code ? `（代码 ${result.code}）` : ''}。按 Enter 可以接着这段对话。`;
      next = null;
    }
  } finally {
    deck?.hide();
    for (const signal of signals) process.off(signal, stop);
    connection?.close();
    await bridge?.close();
  }
}

// The most recently used session of the directory, or a new one.
export async function chooseSession(connection, projectPath, values) {
  let session = values.new
    ? undefined
    : connection.ready.sessions
        .filter((candidate) => candidate.projectPath === projectPath)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!session) {
    const { sessionId } = await connection.request({
      type: 'session.create',
      title: basename(projectPath).slice(0, 120) || projectPath.slice(-120),
      projectPath,
    });
    session = {
      id: sessionId,
      title: basename(projectPath) || projectPath,
      permissionMode: 'auto',
    };
  }
  if (
    values.model !== undefined ||
    values.effort !== undefined ||
    values['permission-mode'] !== undefined
  )
    await connection.request({
      type: 'session.configure',
      sessionId: session.id,
      permissionMode: values['permission-mode'] ?? session.permissionMode,
      ...(values.model !== undefined && { model: values.model }),
      ...(values.effort !== undefined && { effort: values.effort }),
    });
  return session;
}
