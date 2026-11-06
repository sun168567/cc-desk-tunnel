import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { platformOf } from '@cc-desk-tunnel/protocol';
import {
  ArrowLeft,
  Bell,
  Cable,
  CircleHelp,
  FileText,
  Globe,
  Hourglass,
  Info,
  Keyboard,
  Palette,
  Search,
  Settings,
  SlidersHorizontal,
  SquareTerminal,
  UserRound,
} from 'lucide-react';
import type { ConnectedDevice, ProxyClient } from './client.ts';
import WebAccessSettings from './WebAccessSettings.tsx';
import Help from './Help.tsx';
import type { ConnectionForm } from './LoginPage.tsx';
import { connectionWaits, setPrefs, themes, usePrefs, waitRange } from './prefs.ts';
import { viewModes } from './transcriptView.ts';
import type { NotifyKind } from './prefs.ts';
import { waitFields } from './setting-fields.ts';
import { inSummary, sampleStats, statFields, summaryText } from './turnStats.ts';
import { barText, inBar, sampleSession, sessionFields } from './sessionStats.ts';
import { GithubMark, openProject, project } from './project.tsx';
import GlobalInstructions from './GlobalInstructions.tsx';
import IdleCompactionSettings from './IdleCompactionSettings.tsx';
import SettingsPanel from './SettingsPanel.tsx';
import { useShared } from './shared.ts';
import type { ListedConnection } from './shared.ts';
import ShellSettings from './ShellSettings.tsx';
import ShortcutSettings from './ShortcutSettings.tsx';
import { IconButton, Page, Row, Switch } from './ui.tsx';
import type { MenuItem } from './ui.tsx';

export type Section =
  | 'general'
  | 'appearance'
  | 'connection'
  | 'notifications'
  | 'shortcuts'
  | 'context'
  | 'shell'
  | 'web'
  | 'account'
  | 'claude'
  | 'instructions'
  | 'help'
  | 'about';
// The groups say where their settings are kept and what they apply to: this computer, the service (for every device
// connected to it), or Claude Code's own files on the cloud host. `words` is what the search box matches besides the
// name: the settings found inside.
const sections: { id: Section; name: string; group: string; icon: typeof Bell; words: string }[] = [
  {
    id: 'general',
    name: '常规',
    group: '本机',
    icon: Settings,
    words: '窗口 托盘 后台 启动 普通会话 文件夹 审批 绕过权限',
  },
  {
    id: 'appearance',
    name: '外观',
    group: '本机',
    icon: Palette,
    words: '主题 深色 浅色 工作步骤 回复小结 会话栏 输入框 额度 用量 首字 速度 缓存',
  },
  {
    id: 'connection',
    name: '连接',
    group: '本机',
    icon: Cable,
    words: '记住凭据 自动登录 多开 多个连接 窗口 服务端 等待 超时 SSH 执行通道',
  },
  {
    id: 'notifications',
    name: '通知',
    group: '本机',
    icon: Bell,
    words: '提醒 完成 失败 审批 提问 定时任务 连接 提示音',
  },
  {
    id: 'shortcuts',
    name: '快捷键',
    group: '本机',
    icon: Keyboard,
    words: '键盘 组合键 热键 后退 前进 侧栏 缩放',
  },
  {
    id: 'context',
    name: '上下文与缓存',
    group: '服务端',
    icon: Hourglass,
    words: '自动压缩 提示缓存 过期 空闲 上下文 compact',
  },
  {
    id: 'shell',
    name: 'Shell',
    group: '服务端',
    icon: SquareTerminal,
    words: 'PowerShell Git Bash 命令 脚本 终端 偏好',
  },
  {
    id: 'web',
    name: '浏览器访问',
    group: '服务端',
    icon: Globe,
    words: 'Web 网页 证书 域名 两步验证 反向代理 浏览器登录',
  },
  {
    id: 'account',
    name: '账号与额度',
    group: 'Claude Code',
    icon: UserRound,
    words: '登录 退出 订阅 用量 调用日志 重置 读取额度',
  },
  {
    id: 'claude',
    name: 'CLI 设置',
    group: 'Claude Code',
    icon: SlidersHorizontal,
    words: '自动压缩 思考 快速模式 记忆 检查点 缓存 语言 模型 备用模型 署名 工具搜索',
  },
  {
    id: 'instructions',
    name: '全局说明',
    group: 'Claude Code',
    icon: FileText,
    words: 'CLAUDE.md AGENTS.md 提示词 说明',
  },
  { id: 'help', name: '帮助', group: '其他', icon: CircleHelp, words: '说明 常见问题' },
  {
    id: 'about',
    name: '关于与更新',
    group: '其他',
    icon: Info,
    words: '版本 升级 检查更新 项目主页 日志 排查 断开 开发者工具 控制台',
  },
];
// What a page's settings apply to, said under its title.
const here = (browser: boolean) =>
  browser
    ? '只保存在这个浏览器里，只影响在这里打开的页面。'
    : '只保存在这台电脑，只影响这个客户端。';
const everyDevice = '保存在服务端，对所有连接到它的设备生效。';
const thisDevice = '保存在服务端，只对这台电脑生效。';
const kinds: { key: NotifyKind; title: string; detail: string }[] = [
  { key: 'done', title: '任务完成', detail: 'Claude Code 做完了一轮任务' },
  { key: 'failed', title: '任务失败', detail: '一轮任务因错误而结束' },
  { key: 'approval', title: '等待审批', detail: '有操作需要你允许或拒绝' },
  { key: 'question', title: 'Claude 提问', detail: 'Claude 需要你回答问题才能继续' },
  { key: 'schedule', title: '定时任务未发出', detail: '到点的任务发送失败或被跳过' },
  { key: 'connection', title: '连接中断', detail: '与服务的连接意外断开' },
];

// How much of the work behind a reply is shown is a choice of this computer's window too.
function ThemeSettings() {
  const { theme } = usePrefs();
  return (
    <>
      <h2 className="page-heading">主题</h2>
      <div className="card">
        <div className="setting-row stat-picks">
          <span>
            <strong>主题</strong>
            <small>跟随系统时随系统的浅色或深色设置切换</small>
          </span>
          <div className="stat-chips" role="radiogroup" aria-label="主题">
            {themes.map((entry) => (
              <button
                type="button"
                key={entry.theme}
                role="radio"
                className="stat-chip"
                aria-checked={entry.theme === theme}
                onClick={() => setPrefs((prefs) => ({ ...prefs, theme: entry.theme }))}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function TranscriptViewSettings() {
  const { view } = usePrefs();
  const set = (values: Partial<typeof view>) =>
    setPrefs((prefs) => ({ ...prefs, view: { ...prefs.view, ...values } }));
  const current = viewModes.find((entry) => entry.mode === view.mode) ?? viewModes[0];
  return (
    <>
      <h2 className="page-heading">工作步骤展示</h2>
      <div className="card">
        <div className="setting-row stat-picks">
          <span>
            <strong>展示多少</strong>
            <small>{current.detail}</small>
          </span>
          <div className="stat-chips" role="radiogroup" aria-label="工作步骤展示">
            {viewModes.map((entry) => (
              <button
                type="button"
                key={entry.mode}
                role="radio"
                className="stat-chip"
                aria-checked={entry.mode === view.mode}
                onClick={() => set({ mode: entry.mode })}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

// The strip under the input box: its two parts each show the figures switched on, and open a card with all of them.
function SessionBarSettings() {
  const { sessionBar } = usePrefs();
  const set = (values: Partial<typeof sessionBar>) =>
    setPrefs((prefs) => ({ ...prefs, sessionBar: { ...prefs.sessionBar, ...values } }));
  const preview = (['session', 'tokens'] as const)
    .map((group) => barText(group, sampleSession, sessionBar.summary))
    .filter(Boolean)
    .join('　　');
  return (
    <>
      <h2 className="page-heading">会话栏</h2>
      <div className="card">
        <Row title="显示会话栏" detail="输入框下方一行：整个会话的轮数、步数、速度和 Token 用量">
          <Switch
            label="显示会话栏"
            checked={sessionBar.enabled}
            onChange={(enabled) => set({ enabled })}
          />
        </Row>
        <div className="setting-row stat-picks">
          <span>
            <strong>会话栏里显示</strong>
            <small>{preview || '都不选时每一块只显示它的名字'}</small>
          </span>
          <div className="stat-chips" role="group" aria-label="会话栏里显示">
            {sessionFields.map((field) => {
              const on = inBar(field, sessionBar.summary);
              return (
                <button
                  type="button"
                  key={field.key}
                  className="stat-chip"
                  aria-pressed={on}
                  disabled={!sessionBar.enabled}
                  onClick={() => set({ summary: { ...sessionBar.summary, [field.key]: !on } })}
                >
                  {field.label}
                </button>
              );
            })}
          </div>
        </div>
        <Row title="恢复默认" detail="点开后的明细不受这里的选择影响">
          <button
            type="button"
            className="button"
            disabled={Object.keys(sessionBar.summary).length === 0}
            onClick={() => set({ summary: {} })}
          >
            恢复默认
          </button>
        </Row>
      </div>
    </>
  );
}

// The line under each reply is a choice of this computer's window, so it works outside the desktop app too.
function ReplyStats() {
  const { stats } = usePrefs();
  const set = (values: Partial<typeof stats>) =>
    setPrefs((prefs) => ({ ...prefs, stats: { ...prefs.stats, ...values } }));
  return (
    <>
      <h2 className="page-heading">回复小结</h2>
      <div className="card">
        <Row title="显示回复小结" detail="每轮回复末尾一个小按钮，点开看全部明细">
          <Switch
            label="显示回复小结"
            checked={stats.enabled}
            onChange={(enabled) => set({ enabled })}
          />
        </Row>
        <div className="setting-row stat-picks">
          <span>
            <strong>小结里显示</strong>
            <small>{summaryText(sampleStats, stats.summary) || '都不选时只显示“用量明细”'}</small>
          </span>
          <div className="stat-chips" role="group" aria-label="小结里显示">
            {statFields.map((field) => {
              const on = inSummary(field, stats.summary);
              return (
                <button
                  type="button"
                  key={field.key}
                  className="stat-chip"
                  aria-pressed={on}
                  disabled={!stats.enabled}
                  onClick={() => set({ summary: { ...stats.summary, [field.key]: !on } })}
                >
                  {field.label}
                </button>
              );
            })}
          </div>
        </div>
        <Row title="恢复默认" detail="明细里的数据不受这里的选择影响">
          <button
            type="button"
            className="button"
            disabled={Object.keys(stats.summary).length === 0}
            onClick={() => set({ summary: {} })}
          >
            恢复默认
          </button>
        </Row>
      </div>
    </>
  );
}

// A number of seconds, taken when the field is left or Enter is pressed; anything out of range is put back.
function Seconds({
  label,
  value,
  change,
}: {
  label: string;
  value: number;
  change: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const seconds = Number(text);
    if (Number.isInteger(seconds) && seconds >= waitRange.min && seconds <= waitRange.max)
      change(seconds);
    else setText(String(value));
  };
  return (
    <span className="setting-actions">
      <input
        className="setting-number"
        type="number"
        min={waitRange.min}
        max={waitRange.max}
        aria-label={label}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
        }}
      />
      秒
    </span>
  );
}

// The computer's connections, each a window of its own to a service of its own: see electron/connections.cjs.
function Connections() {
  const [list, setList] = useState<ListedConnection[]>([]);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState('');
  const names = useShared('connections');
  // Whether a window is open is its process's to tell, so it is asked again while the page is shown.
  useEffect(() => {
    const read = () => void window.desktop!.connections().then(setList);
    read();
    const timer = setInterval(read, 2000);
    return () => clearInterval(timer);
  }, [names]);
  const act = (work: Promise<ListedConnection[] | void>) =>
    work.then(
      (next) => {
        setError('');
        if (next) setList(next);
        return true;
      },
      (failure) => {
        setError(
          String(failure?.message ?? failure).replace(/^.*?'connections:\w+': (Error: )?/, ''),
        );
        return false;
      },
    );
  return (
    <>
      <h2 className="page-heading">多个连接</h2>
      <div className="card">
        {list.map((entry) => (
          <Row
            key={entry.id}
            title={entry.name}
            detail={entry.current ? '当前窗口' : entry.open ? '已打开' : '未打开'}
          >
            {editing?.id === entry.id ? (
              <form
                className="setting-actions"
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(window.desktop!.renameConnection(entry.id, editing.name)).then(
                    (done) => done && setEditing(null),
                  );
                }}
              >
                <input
                  className="setting-name"
                  aria-label="连接的名称"
                  maxLength={24}
                  autoFocus
                  value={editing.name}
                  onChange={(event) => setEditing({ id: entry.id, name: event.target.value })}
                />
                <button type="submit" className="button" disabled={!editing.name.trim()}>
                  保存
                </button>
                <button type="button" className="button" onClick={() => setEditing(null)}>
                  取消
                </button>
              </form>
            ) : (
              <span className="setting-actions">
                {!entry.current && (
                  <button
                    type="button"
                    className="button"
                    aria-label={`打开 ${entry.name}`}
                    onClick={() => void act(window.desktop!.openConnection(entry.id))}
                  >
                    {entry.open ? '切换到' : '打开'}
                  </button>
                )}
                <button
                  type="button"
                  className="button"
                  aria-label={`改名 ${entry.name}`}
                  onClick={() => setEditing({ id: entry.id, name: entry.name })}
                >
                  改名
                </button>
                {entry.id && !entry.current && (
                  <button
                    type="button"
                    className="button danger"
                    aria-label={`删除 ${entry.name}`}
                    onClick={() => {
                      if (
                        window.confirm(
                          `删除连接“${entry.name}”？它在这台电脑上保存的服务地址、凭据、草稿和定时任务会一并删除；服务端上的会话不受影响。`,
                        )
                      )
                        void act(window.desktop!.removeConnection(entry.id));
                    }}
                  >
                    删除
                  </button>
                )}
              </span>
            )}
          </Row>
        ))}
        <Row
          title="新建连接"
          detail="再开一个窗口去连另一台服务端。每个连接各有自己的服务地址、凭据、草稿和定时任务；项目列表、通知、快捷键等本机设置是共用的"
        >
          <form
            className="setting-actions"
            onSubmit={(event) => {
              event.preventDefault();
              void act(window.desktop!.createConnection(name)).then((done) => done && setName(''));
            }}
          >
            <input
              className="setting-name"
              aria-label="新连接的名称"
              placeholder="例如：工作"
              maxLength={24}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <button type="submit" className="button" disabled={!name.trim()}>
              新建并打开
            </button>
          </form>
        </Row>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function General({
  browser,
  workspaceRoot,
  chooseWorkspace,
}: {
  browser: boolean;
  workspaceRoot: string;
  chooseWorkspace: (reset: boolean) => void;
}) {
  const [closeToTray, setCloseToTray] = useState<boolean | null>(null);
  const { bypassPermissions } = usePrefs();
  useEffect(() => {
    void window.desktop?.windowSettings().then((values) => setCloseToTray(values.closeToTray));
  }, []);
  return (
    <Page title="常规" intro={here(browser)}>
      {window.desktop && (
        <>
          <h2 className="page-heading">窗口</h2>
          <div className="card">
            <Row
              title="关闭窗口时留在后台"
              detail="关闭只是收到托盘，连接和运行中的任务继续；在托盘图标上选“退出”才结束"
            >
              <Switch
                label="关闭窗口时留在后台"
                checked={closeToTray ?? true}
                disabled={closeToTray === null}
                onChange={(value) => {
                  setCloseToTray(value);
                  void window.desktop!.setWindowSettings({ closeToTray: value });
                }}
              />
            </Row>
          </div>
          <h2 className="page-heading">会话</h2>
          <div className="card">
            <Row
              title="普通会话的文件夹"
              detail={
                <>
                  不属于任何项目的新会话在这里各得一个工作目录；已有的会话留在原处
                  <code className="setting-path">{workspaceRoot}</code>
                </>
              }
            >
              <span className="setting-actions">
                <button type="button" className="button" onClick={() => chooseWorkspace(false)}>
                  更改
                </button>
                <button type="button" className="button" onClick={() => chooseWorkspace(true)}>
                  恢复默认
                </button>
              </span>
            </Row>
          </div>
        </>
      )}
      <h2 className="page-heading">审批</h2>
      <div className="card">
        <Row
          title="允许绕过权限"
          detail="审批模式里多出“绕过权限”：Claude 做任何事都不再询问，包括在你的电脑上执行命令。只建议在测试机或虚拟机里打开"
        >
          <Switch
            label="允许绕过权限"
            checked={bypassPermissions}
            onChange={(value) => setPrefs((prefs) => ({ ...prefs, bypassPermissions: value }))}
          />
        </Row>
      </div>
    </Page>
  );
}

function Appearance({ browser }: { browser: boolean }) {
  const { quota } = usePrefs();
  return (
    <Page title="外观" intro={here(browser)}>
      <ThemeSettings />
      {window.desktop && (
        <>
          <h2 className="page-heading">输入框</h2>
          <div className="card">
            <Row
              title="在输入框旁显示额度"
              detail="5 小时和每周额度的已用比例，取自最近一次读数；点它打开“账号与额度”"
            >
              <Switch
                label="在输入框旁显示额度"
                checked={quota}
                onChange={(value) => setPrefs((prefs) => ({ ...prefs, quota: value }))}
              />
            </Row>
          </div>
        </>
      )}
      <TranscriptViewSettings />
      <ReplyStats />
      <SessionBarSettings />
    </Page>
  );
}

function ConnectionSettings({
  form,
  changeForm,
}: {
  form: ConnectionForm;
  changeForm: (values: Partial<ConnectionForm>) => void;
}) {
  const { connection } = usePrefs();
  return (
    <Page title="连接" intro={here(false)}>
      <h2 className="page-heading">登录</h2>
      <div className="card">
        <Row title="记住凭据" detail="服务凭据经当前系统账户加密后保存在本机">
          <Switch
            label="记住凭据"
            checked={form.remember}
            onChange={(remember) => changeForm({ remember, autoLogin: remember && form.autoLogin })}
          />
        </Row>
        <Row title="自动登录" detail="启动客户端后直接连接上次的服务">
          <Switch
            label="自动登录"
            checked={form.autoLogin}
            onChange={(autoLogin) =>
              changeForm({ autoLogin, remember: autoLogin || form.remember })
            }
          />
        </Row>
      </div>
      <Connections />
      <h2 className="page-heading">连接等待时间</h2>
      <div className="card">
        {waitFields.map(({ step, title, detail }) => (
          <Row key={step} title={title} detail={`${detail}。默认 ${connectionWaits[step]} 秒`}>
            <Seconds
              label={title}
              value={connection[step]}
              change={(seconds) =>
                setPrefs((prefs) => ({
                  ...prefs,
                  connection: { ...prefs.connection, [step]: seconds },
                }))
              }
            />
          </Row>
        ))}
        <Row title="恢复默认" detail="下次连接时生效；连接正常时不需要改">
          <button
            type="button"
            className="button"
            disabled={waitFields.every(({ step }) => connection[step] === connectionWaits[step])}
            onClick={() => setPrefs((prefs) => ({ ...prefs, connection: connectionWaits }))}
          >
            恢复默认
          </button>
        </Row>
      </div>
    </Page>
  );
}
function Notices() {
  const { notify } = usePrefs();
  const set = (values: Partial<typeof notify>) =>
    setPrefs((prefs) => ({ ...prefs, notify: { ...prefs.notify, ...values } }));
  return (
    <Page
      title="通知"
      intro="窗口收在托盘或不在前台时，用系统通知提醒需要你知道的事；点通知回到对应的会话。正在看的会话不会重复提醒。"
    >
      <div className="card">
        <Row title="开启通知" detail="关闭后既不弹出系统通知，也不记入通知列表">
          <Switch
            label="开启通知"
            checked={notify.enabled}
            onChange={(enabled) => set({ enabled })}
          />
        </Row>
        <Row title="提示音" detail="弹出系统通知时播放系统的通知声音">
          <Switch
            label="提示音"
            checked={notify.sound}
            disabled={!notify.enabled}
            onChange={(sound) => set({ sound })}
          />
        </Row>
      </div>
      <h2 className="page-heading">提醒哪些事</h2>
      <div className="card">
        {kinds.map(({ key, title, detail }) => (
          <Row key={key} title={title} detail={detail}>
            <Switch
              label={title}
              checked={notify[key]}
              disabled={!notify.enabled}
              onChange={(value) => set({ [key]: value })}
            />
          </Row>
        ))}
      </div>
      {window.desktop && (
        <button
          type="button"
          className="button"
          onClick={() =>
            void window.desktop!.notify({
              title: '测试通知',
              body: '通知工作正常。',
              sessionId: null,
              silent: !notify.sound,
              always: true,
            })
          }
        >
          发送一条测试通知
        </button>
      )}
    </Page>
  );
}

function About({
  version,
  service,
  adapterName,
  updates,
  showNotes,
}: {
  version: string;
  service: string | null;
  adapterName: string;
  updates: MenuItem[];
  showNotes: (version: string) => void;
}) {
  return (
    <Page title="关于与更新">
      <div className="card">
        <Row title="客户端版本">
          <span className="setting-actions">
            <span className="setting-value">{version || '浏览器开发入口'}</span>
            {version && (
              <button type="button" className="button" onClick={() => showNotes(version)}>
                这一版的更新内容
              </button>
            )}
          </span>
        </Row>
        <Row title="服务端版本">
          <span className="setting-value">{service ?? '未知'}</span>
        </Row>
        <Row title="运行方式">
          <span className="setting-value">{adapterName}</span>
        </Row>
      </div>
      <h2 className="page-heading">更新</h2>
      <div className="card">
        <Row
          title="客户端与服务端需要同一版本"
          detail="服务端跟随发布页；客户端的安装包由所连接的服务端提供，也可以在登录页改从 GitHub 发布页下载，校验后覆盖升级"
        >
          <span className="setting-actions">
            {updates.map((item) => (
              <button
                type="button"
                className="button"
                key={item.label}
                disabled={item.disabled}
                onClick={item.run}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
            {updates.length === 0 && <span className="setting-value">没有可用的更新操作</span>}
          </span>
        </Row>
      </div>
      {window.desktop && (
        <>
          <h2 className="page-heading">排查</h2>
          <div className="card">
            <Row
              title="连接日志"
              detail="记录每次连接何时建立、何时断开、是哪一方先断开及原因，保存在本机；不含服务凭据、对话和命令内容。连接无故中断时可以对照服务端日志查看"
            >
              <button
                type="button"
                className="button"
                onClick={() => void window.desktop!.openLogs()}
              >
                打开日志文件夹
              </button>
            </Row>
            <Row
              title="开发者工具"
              detail="查看界面的控制台报错、检查元素或录制性能记录，反馈界面问题时用得上。在单独的窗口里打开；其中能看到当前页面的全部内容，包括对话，不要按他人的要求在里面粘贴代码"
            >
              <button
                type="button"
                className="button"
                onClick={() => void window.desktop!.openDevTools()}
              >
                打开开发者工具
              </button>
            </Row>
          </div>
        </>
      )}
      {project.url && (
        <button type="button" className="button" onClick={openProject}>
          <GithubMark />
          项目主页 · {project.name}
        </button>
      )}
    </Page>
  );
}

// Settings in one place, sorted by where they are kept: this computer, the service, or Claude Code's own files on the
// cloud host.
export default function SettingsPage({
  client,
  section,
  go,
  native,
  account,
  form,
  changeForm,
  workspaceRoot,
  chooseWorkspace,
  version,
  service,
  adapterName,
  updates,
  showNotes,
  back,
  browser = false,
  here,
}: {
  // This computer as the service lists it, with the shells it runs Claude's scripts in. A Windows one has a page for
  // the shell Claude should prefer.
  here?: ConnectedDevice;
  // Given before a connection exists: only this computer's own settings are shown, and this leaves them.
  back?: () => void;
  browser?: boolean;
  client: ProxyClient;
  section: Section;
  go: (section: Section) => void;
  native: boolean;
  // The account page is rendered by the caller, which owns its data.
  account: ReactNode;
  form: ConnectionForm;
  changeForm: (values: Partial<ConnectionForm>) => void;
  workspaceRoot: string;
  chooseWorkspace: (reset: boolean) => void;
  version: string;
  service: string | null;
  adapterName: string;
  updates: MenuItem[];
  showNotes: (version: string) => void;
}) {
  const [search, setSearch] = useState('');
  const term = search.trim().toLowerCase();
  // Before a connection only this computer's; in a browser no computer's own nor Claude Code's files; the service's
  // where there is one to keep them. A page with nothing to set where it is shown is not listed.
  const shown = sections.filter(
    (item) =>
      (!back || item.group === '本机') &&
      (item.id !== 'connection' || window.desktop) &&
      (!browser || !['context', 'account', 'claude', 'instructions'].includes(item.id)) &&
      (item.id !== 'context' || native) &&
      (item.id !== 'shell' || (native && !browser && !!here && platformOf(here) === 'win32')) &&
      (item.id !== 'web' || native || browser) &&
      `${item.name} ${item.words}`.toLowerCase().includes(term),
  );
  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-brand">
          {back && (
            <IconButton title="返回登录" onClick={back}>
              <ArrowLeft />
            </IconButton>
          )}
          <span className="brand">{back ? '本机设置' : '设置'}</span>
        </div>
        <label className="session-search">
          <Search />
          <input
            aria-label="搜索设置"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索"
          />
        </label>
        <nav className="session-list" aria-label="设置分类">
          {shown.map((item, index) => (
            <div key={item.id}>
              {item.group !== shown[index - 1]?.group && (
                <div className="list-heading">{item.group}</div>
              )}
              <button
                type="button"
                className="side-action"
                aria-current={item.id === section ? 'page' : undefined}
                onClick={() => go(item.id)}
              >
                <item.icon />
                {item.name}
              </button>
            </div>
          ))}
          {shown.length === 0 && <p className="list-empty">没有匹配的设置</p>}
        </nav>
      </aside>
      <main className="workspace">
        {section === 'account' ? (
          account
        ) : section === 'claude' ? (
          native ? (
            <SettingsPanel client={client} />
          ) : (
            <Page
              title="CLI 设置"
              intro="离线模拟没有 Claude Code 设置；连接远程代理后在这里修改。"
            />
          )
        ) : section === 'instructions' ? (
          native ? (
            <GlobalInstructions client={client} />
          ) : (
            <Page title="全局说明" intro="离线模拟没有全局说明；连接远程代理后在这里修改。" />
          )
        ) : section === 'context' ? (
          <Page title="上下文与缓存" intro={everyDevice}>
            <IdleCompactionSettings client={client} />
          </Page>
        ) : section === 'shell' && here ? (
          <Page title="Shell" intro={thisDevice}>
            <ShellSettings client={client} here={here} />
          </Page>
        ) : section === 'web' ? (
          <Page title="浏览器访问" intro={everyDevice}>
            <WebAccessSettings client={client} browser={browser} connectionUrl={form.url} />
          </Page>
        ) : section === 'general' ? (
          <General
            browser={browser}
            workspaceRoot={workspaceRoot}
            chooseWorkspace={chooseWorkspace}
          />
        ) : section === 'appearance' ? (
          <Appearance browser={browser} />
        ) : section === 'connection' ? (
          <ConnectionSettings form={form} changeForm={changeForm} />
        ) : section === 'notifications' ? (
          <Notices />
        ) : section === 'shortcuts' ? (
          <ShortcutSettings />
        ) : section === 'help' ? (
          <Help />
        ) : (
          <About
            version={version}
            service={service}
            adapterName={adapterName}
            updates={updates}
            showNotes={showNotes}
          />
        )}
      </main>
    </>
  );
}
