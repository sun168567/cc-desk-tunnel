import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { addWorktree, ownWorktree, removeWorktree, repositoryOf } from './git.mjs';
import { newlyWaiting, notify } from './notify.mjs';

// Cells a text takes in a terminal: East Asian wide characters take two. The list draws only characters whose width
// is not ambiguous, as glyphs like ● overlap their neighbours in some terminals.
const WIDE = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];
export function cellWidth(text) {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code < 0x20 || (code >= 0x300 && code <= 0x36f) || (code >= 0xfe00 && code <= 0xfe0f))
      continue;
    width += WIDE.some(([low, high]) => code >= low && code <= high) ? 2 : 1;
  }
  return width;
}
// Exactly `width` cells: cut with ".." when too long, padded with spaces when short.
export function fit(text, width) {
  if (width <= 0) return '';
  if (cellWidth(text) <= width) return text + ' '.repeat(width - cellWidth(text));
  if (width <= 2) return '.'.repeat(width);
  let kept = '';
  let used = 0;
  for (const character of text) {
    const next = cellWidth(character);
    if (used + next > width - 2) break;
    kept += character;
    used += next;
  }
  return kept + '..' + ' '.repeat(width - used - 2);
}
export function ago(time, now = Date.now()) {
  const seconds = Math.max(0, (now - Date.parse(time)) / 1000);
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
const tilde = (path, home) =>
  path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;

// Label and SGR colour of what an agent is doing.
const STATUS = {
  busy: ['运行中', '32'],
  waiting: ['等你', '33;1'],
  idle: ['空闲', '36'],
  starting: ['启动中', '2'],
};
const STOPPED = ['未启动', '2'];

// The list's rows: sessions grouped by repository (a repository's worktrees with its main checkout; a directory
// outside git on its own), the most recently active group first; in a group, running agents first, then by
// activity. A filter keeps sessions whose title, directory or branch contains it.
export function deckRows(
  sessions,
  terminals,
  filter = '',
  home = homedir(),
  repositories = new Map(),
) {
  const needle = filter.trim().toLowerCase();
  const groups = new Map();
  for (const session of sessions) {
    const repository = repositories.get(session.projectPath);
    const key = repository?.root ?? session.projectPath;
    const shown = tilde(key, home);
    const branch = repository?.branch ?? null;
    const words = `${session.title} ${tilde(session.projectPath, home)} ${branch ?? ''}`;
    if (needle && !words.toLowerCase().includes(needle)) continue;
    const terminal = terminals.get(session.id);
    const activity =
      terminal && terminal.since > session.updatedAt ? terminal.since : session.updatedAt;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { shown, latest: '', items: [] }));
    group.items.push({ session, terminal, activity, branch, repository });
    if (activity > group.latest) group.latest = activity;
  }
  const rows = [];
  for (const group of [...groups.values()].sort((a, b) => b.latest.localeCompare(a.latest))) {
    rows.push({ header: group.shown });
    group.items.sort((a, b) => !!b.terminal - !!a.terminal || b.activity.localeCompare(a.activity));
    rows.push(...group.items);
  }
  return rows;
}

const KEYS = /\x1b\[[0-9;?]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b|[\s\S]/gu;

// The agent list, drawn on the alternate screen between visits to agents. It follows the service's sessions and
// terminals all the time, so an agent out of sight that starts waiting for the user, or finishes its turn, rings
// the terminal bell and shows in the window title.
export class Deck {
  constructor(
    connection,
    {
      input = process.stdin,
      output = process.stdout,
      cwd,
      host = '',
      home = homedir(),
      // Agents run in the background daemon and outlive this list.
      background = false,
    } = {},
  ) {
    this.background = background;
    this.connection = connection;
    this.input = input;
    this.output = output;
    this.cwd = cwd ?? process.cwd();
    this.host = host;
    this.home = home;
    this.sessions = new Map(connection.ready.sessions.map((session) => [session.id, session]));
    // Project directory → its repository, read with git on this computer; null outside one.
    this.repositories = new Map();
    this.terminals = new Map();
    this.selected = null;
    this.filter = '';
    this.mode = null;
    this.message = '';
    this.shown = false;
    // The session whose terminal is on screen; it does not ring.
    this.attached = null;
    this.title = '';
    this.decoder = new StringDecoder('utf8');
    this.onData = (chunk) => {
      const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
      for (const [key] of text.matchAll(KEYS)) this.key(key);
      if (this.shown) this.render();
    };
    this.onResize = () => this.render();
    connection.onMessage((message) => this.receive(message));
    connection.closed.then((reason) => this.finish({ quit: true, lost: reason ?? '连接已断开。' }));
  }
  receive(message) {
    if (message.type === 'session.updated') this.sessions.set(message.session.id, message.session);
    else if (message.type === 'session.deleted') this.sessions.delete(message.sessionId);
    else if (message.type === 'terminals.state') {
      const previous = this.terminals;
      this.terminals = new Map(message.terminals.map((terminal) => [terminal.sessionId, terminal]));
      // With the daemon running, the daemon notifies.
      if (!this.background)
        for (const terminal of newlyWaiting(previous, message.terminals))
          notify(
            `${this.sessions.get(terminal.sessionId)?.title ?? 'agent'} 等你`,
            '在 ccdt 里进入处理。',
          );
      for (const terminal of this.terminals.values()) {
        const before = previous.get(terminal.sessionId)?.status;
        if (
          terminal.sessionId !== this.attached &&
          before !== terminal.status &&
          (terminal.status === 'waiting' || (terminal.status === 'idle' && before === 'busy'))
        )
          this.output.write('\x07');
      }
      const waiting = [...this.terminals.values()].filter(
        (terminal) => terminal.status === 'waiting',
      ).length;
      const title = waiting ? `ccdt · ${waiting} 个等你` : 'ccdt';
      if (title !== this.title) this.output.write(`\x1b]2;${(this.title = title)}\x07`);
    } else return;
    if (this.shown) this.render();
  }
  // Branches change while agents work, so they are read again each time the list shows.
  async readRepositories() {
    const paths = new Set([...this.sessions.values()].map((session) => session.projectPath));
    await Promise.all(
      [...paths].map(async (path) => this.repositories.set(path, await repositoryOf(path))),
    );
    if (this.shown) this.render();
  }
  notice(text) {
    this.message = text;
    if (this.shown) this.render();
  }
  // Shows the list until the user picks an agent, `{ sessionId, continued }`, or leaves, `{ quit: true }`.
  choose(message = '') {
    this.message = message;
    this.attached = null;
    void this.readRepositories();
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.show();
    });
  }
  show() {
    this.shown = true;
    this.input.setRawMode?.(true);
    this.input.on('data', this.onData);
    this.input.resume();
    this.output.on('resize', this.onResize);
    this.clock = setInterval(() => this.render(), 30000);
    this.output.write('\x1b[?1049h\x1b[?25l');
    this.render();
  }
  hide() {
    if (!this.shown) return;
    this.shown = false;
    clearInterval(this.clock);
    this.input.off('data', this.onData);
    this.output.off('resize', this.onResize);
    this.input.pause();
    this.output.write('\x1b[?25h\x1b[?1049l');
  }
  finish(result) {
    this.hide();
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(result);
  }
  rows() {
    return deckRows(
      this.sessions.values(),
      this.terminals,
      this.filter,
      this.home,
      this.repositories,
    );
  }
  items() {
    return this.rows().filter((row) => !row.header);
  }
  current() {
    return this.items().find((item) => item.session.id === this.selected) ?? this.items()[0];
  }
  move(step) {
    const items = this.items();
    if (!items.length) return;
    const index = items.findIndex((item) => item.session.id === this.selected);
    const next = index < 0 ? 0 : Math.min(items.length - 1, Math.max(0, index + step));
    this.selected = items[next].session.id;
  }
  // Runs a service request from the list; its failure becomes the message line.
  act(command, done = '') {
    this.connection.request(command).then(
      () => this.notice(done),
      (error) => this.notice(error.message),
    );
  }
  key(key) {
    const mode = this.mode;
    if (mode?.type === 'confirm') {
      this.mode = null;
      if (key === 'y' || key === 'Y') mode.yes();
      else this.message = '已取消。';
      return;
    }
    if (mode) {
      if (key === '\r') {
        this.mode = null;
        if (mode.type === 'prompt') void mode.submit(mode.value.trim());
      } else if (key === '\x1b' || key === '\x03') {
        this.mode = null;
        if (mode.type === 'search') this.filter = '';
      } else if (key === '\x7f' || key === '\b') mode.value = [...mode.value].slice(0, -1).join('');
      else if (!key.startsWith('\x1b') && key >= ' ') mode.value += key;
      if (mode.type === 'search') this.filter = mode.value;
      return;
    }
    this.message = '';
    const item = this.current();
    switch (key) {
      case 'j':
      case '\x1b[B':
      case '\x1bOB':
        return this.move(1);
      case 'k':
      case '\x1b[A':
      case '\x1bOA':
        return this.move(-1);
      case 'g':
        return this.move(-Infinity);
      case 'G':
        return this.move(Infinity);
      case '\r':
        if (item) this.finish({ sessionId: item.session.id, continued: true });
        return;
      case 'n':
        this.mode = {
          type: 'prompt',
          label: '新 agent 的目录：',
          value: tilde(item?.session.projectPath ?? this.cwd, this.home),
          submit: (path) => this.create(path),
        };
        return;
      case 'd':
        if (!item?.terminal) return void (this.message = '这个会话没有运行中的 agent。');
        this.mode = {
          type: 'confirm',
          text: `结束 agent「${item.session.title}」？对话会保留，之后可以接着。(y/N)`,
          yes: () =>
            this.act({
              type: 'terminal.close',
              sessionId: item.session.id,
              terminalId: item.terminal.terminalId,
            }),
        };
        return;
      case 'w': {
        const project = item?.repository?.root ?? item?.session.projectPath ?? this.cwd;
        const stamp = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '');
        this.mode = {
          type: 'prompt',
          label: `${tilde(project, this.home)} 的新 worktree 分支：`,
          value: `ccdt/${stamp}`,
          submit: (branch) => branch && this.createWorktree(project, branch),
        };
        return;
      }
      case 'x': {
        if (!item) return;
        if (item.terminal) return void (this.message = '先按 d 结束这个 agent，再删除会话。');
        const path = item.session.projectPath;
        // A worktree ccdt made goes with its last session; its branch stays for merging.
        const worktree =
          item.repository &&
          ownWorktree(item.repository.root, path) &&
          ![...this.sessions.values()].some(
            (other) => other.id !== item.session.id && other.projectPath === path,
          );
        this.mode = {
          type: 'confirm',
          text: worktree
            ? `删除会话「${item.session.title}」和它的 worktree（分支 ${item.branch ?? '?'} 保留）？(y/N)`
            : `删除会话「${item.session.title}」？它的对话记录会一并删除。(y/N)`,
          yes: () => this.remove(item.session.id, worktree ? path : null),
        };
        return;
      }
      case 'r':
        if (!item) return;
        this.mode = {
          type: 'prompt',
          label: '新名字：',
          value: item.session.title,
          submit: (title) =>
            title && this.act({ type: 'session.rename', sessionId: item.session.id, title }),
        };
        return;
      case '/':
        this.mode = { type: 'search', label: '搜索：', value: this.filter };
        return;
      case 'q':
      case '\x03': {
        const running = this.terminals.size;
        if (!running || this.background) return this.finish({ quit: true });
        this.mode = {
          type: 'confirm',
          text: `还有 ${running} 个 agent 在运行，退出会结束它们。确定退出？(y/N)`,
          yes: () => this.finish({ quit: true }),
        };
        return;
      }
    }
  }
  async remove(sessionId, worktree) {
    if (worktree)
      try {
        await removeWorktree(worktree);
      } catch (error) {
        return this.notice(error.message);
      }
    this.act(
      { type: 'session.delete', sessionId },
      worktree ? '已删除会话和 worktree。' : '已删除。',
    );
  }
  async createWorktree(project, branch) {
    this.notice(`创建 worktree ${branch} …`);
    let path;
    try {
      path = await addWorktree(project, branch);
    } catch (error) {
      return this.notice(error.message);
    }
    return this.create(path, branch);
  }
  // A new session for a directory on this computer, opened at once.
  async create(path, title) {
    if (!path) return;
    const expanded = path === '~' || path.startsWith('~/') ? this.home + path.slice(1) : path;
    let projectPath;
    try {
      projectPath = await realpath(resolve(this.cwd, expanded));
      if (!(await stat(projectPath)).isDirectory()) throw new Error();
    } catch {
      return this.notice(`不是可用的目录：${path}`);
    }
    try {
      const { sessionId } = await this.connection.request({
        type: 'session.create',
        title: (title ?? basename(projectPath)).slice(0, 120) || projectPath.slice(-120),
        projectPath,
      });
      this.selected = sessionId;
      this.finish({ sessionId, continued: false });
    } catch (error) {
      this.notice(error.message);
    }
  }
  render() {
    if (!this.shown) return;
    const width = Math.max(40, this.output.columns || 80);
    const height = Math.max(10, this.output.rows || 24);
    const rows = this.rows();
    const items = rows.filter((row) => !row.header);
    if (!items.some((item) => item.session.id === this.selected))
      this.selected = items[0]?.session.id ?? null;
    const count = (status) =>
      [...this.terminals.values()].filter((terminal) => terminal.status === status).length;
    const summary = [
      `${this.terminals.size} 个 agent`,
      count('waiting') && `\x1b[33;1m${count('waiting')} 个等你\x1b[0m`,
      count('busy') && `${count('busy')} 个运行中`,
      this.background && '\x1b[2m后台常驻\x1b[0m',
    ]
      .filter(Boolean)
      .join(' · ');
    const lines = [
      ` \x1b[1mccdt\x1b[0m  ${summary}${this.host ? `  \x1b[2m${this.host}\x1b[0m` : ''}`,
      '',
    ];
    const body = [];
    for (const row of rows) {
      if (row.header) {
        body.push({ text: ` \x1b[1m${fit(row.header, width - 2)}\x1b[0m` });
        continue;
      }
      const [label, colour] = row.terminal ? STATUS[row.terminal.status] : STOPPED;
      const selected = row.session.id === this.selected;
      const time = ago(row.activity);
      const text =
        ` ${selected ? '>' : ' '} \x1b[${colour}m${fit(label, 6)}\x1b[0m` +
        (selected ? '\x1b[7m' : '') +
        ` ${fit(row.branch ? `${row.session.title}  [${row.branch}]` : row.session.title, width - 24)} ${fit(time, 11)}` +
        '\x1b[0m';
      body.push({ text, selected });
    }
    if (!rows.length)
      body.push({
        text: this.filter
          ? '   没有符合搜索的会话。按 Esc 清除搜索。'
          : '   还没有会话。按 n 新建一个 agent。',
      });
    const room = height - 5;
    const at = Math.max(
      0,
      body.findIndex((line) => line.selected),
    );
    this.offset = Math.min(
      Math.max(this.offset ?? 0, at - room + 1),
      at,
      Math.max(0, body.length - room),
    );
    this.offset = Math.max(0, this.offset);
    lines.push(...body.slice(this.offset, this.offset + room).map((line) => line.text));
    while (lines.length < height - 2) lines.push('');
    const mode = this.mode;
    let cursor = null;
    if (mode?.type === 'confirm') lines.push(` \x1b[33m${fit(mode.text, width - 2)}\x1b[0m`);
    else if (mode) {
      const text = fit(mode.label + mode.value, width - 3).trimEnd();
      lines.push(` ${text}`);
      cursor = [lines.length, 2 + cellWidth(text)];
    } else lines.push(` ${fit(this.message, width - 2)}`);
    const keys = mode
      ? 'Enter 确认  Esc 取消'
      : `Enter 进入  n 新建  w worktree  d 结束  x 删除  r 改名  / 搜索  q 退出${width >= 98 ? '  |  Ctrl+Q 从 agent 回到这里' : ''}`;
    lines.push(` \x1b[2m${fit(keys, width - 2)}\x1b[0m`);
    this.output.write(
      '\x1b[H' +
        lines.map((line) => `${line}\x1b[K`).join('\r\n') +
        '\x1b[J' +
        (cursor ? `\x1b[${cursor[0]};${cursor[1]}H\x1b[?25h` : '\x1b[?25l'),
    );
  }
}
