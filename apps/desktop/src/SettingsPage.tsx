import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Bell,
  CircleHelp,
  Info,
  Search,
  Settings2,
  SlidersHorizontal,
  UserRound,
} from 'lucide-react';
import type { ProxyClient } from './client.ts';
import Help from './Help.tsx';
import type { ConnectionForm } from './LoginPage.tsx';
import { setPrefs, usePrefs } from './prefs.ts';
import type { NotifyKind } from './prefs.ts';
import { GithubMark, openProject, project } from './project.tsx';
import SettingsPanel from './SettingsPanel.tsx';
import { Switch } from './ui.tsx';
import type { MenuItem } from './ui.tsx';

export type Section = 'account' | 'claude' | 'general' | 'notifications' | 'help' | 'about';
// `words` is what the search box matches besides the name: the settings found inside.
const sections: { id: Section; name: string; group: string; icon: typeof Bell; words: string }[] = [
  {
    id: 'account',
    name: '账号与额度',
    group: 'Claude Code',
    icon: UserRound,
    words: '登录 退出 订阅 用量 调用日志 重置',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    group: 'Claude Code',
    icon: Settings2,
    words: '自动压缩 思考 快速模式 记忆 检查点 缓存 语言 额度 模型',
  },
  {
    id: 'general',
    name: '常规',
    group: '客户端',
    icon: SlidersHorizontal,
    words: '托盘 后台 记住凭据 自动登录 启动 普通会话 文件夹',
  },
  {
    id: 'notifications',
    name: '通知',
    group: '客户端',
    icon: Bell,
    words: '提醒 完成 失败 审批 提问 定时任务 连接 提示音',
  },
  { id: 'help', name: '帮助', group: '其他', icon: CircleHelp, words: '说明 快捷键 常见问题' },
  {
    id: 'about',
    name: '关于与更新',
    group: '其他',
    icon: Info,
    words: '版本 升级 检查更新 项目主页',
  },
];
const kinds: { key: NotifyKind; title: string; detail: string }[] = [
  { key: 'done', title: '任务完成', detail: 'Claude Code 做完了一轮任务' },
  { key: 'failed', title: '任务失败', detail: '一轮任务因错误而结束' },
  { key: 'approval', title: '等待审批', detail: '有操作需要你允许或拒绝' },
  { key: 'question', title: 'Claude 提问', detail: 'Claude 需要你回答问题才能继续' },
  { key: 'schedule', title: '定时任务未发出', detail: '到点的任务发送失败或被跳过' },
  { key: 'connection', title: '连接中断', detail: '与服务的连接意外断开' },
];

function Row({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <span>
        <strong>{title}</strong>
        {detail && <small>{detail}</small>}
      </span>
      {children}
    </div>
  );
}

function General({
  form,
  changeForm,
  workspaceRoot,
  chooseWorkspace,
}: {
  form: ConnectionForm;
  changeForm: (values: Partial<ConnectionForm>) => void;
  workspaceRoot: string;
  chooseWorkspace: (reset: boolean) => void;
}) {
  const [closeToTray, setCloseToTray] = useState<boolean | null>(null);
  useEffect(() => {
    void window.desktop?.windowSettings().then((values) => setCloseToTray(values.closeToTray));
  }, []);
  return (
    <section className="page" aria-label="常规">
      <div className="page-body">
        <h1 className="page-title">常规</h1>
        {!window.desktop && <p className="muted">这些设置只在桌面客户端里有。</p>}
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
                detail="不属于任何项目的新会话在这里各得一个工作目录；已有的会话留在原处"
              >
                <span className="setting-actions">
                  <code className="setting-value">{workspaceRoot}</code>
                  <button type="button" className="button" onClick={() => chooseWorkspace(false)}>
                    更改
                  </button>
                  <button type="button" className="button" onClick={() => chooseWorkspace(true)}>
                    恢复默认
                  </button>
                </span>
              </Row>
            </div>
            <h2 className="page-heading">连接</h2>
            <div className="card">
              <Row title="记住凭据" detail="服务凭据经当前 Windows 账户加密后保存在本机">
                <Switch
                  label="记住凭据"
                  checked={form.remember}
                  onChange={(remember) =>
                    changeForm({ remember, autoLogin: remember && form.autoLogin })
                  }
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
          </>
        )}
      </div>
    </section>
  );
}

function Notices() {
  const { notify } = usePrefs();
  const set = (values: Partial<typeof notify>) =>
    setPrefs((prefs) => ({ ...prefs, notify: { ...prefs.notify, ...values } }));
  return (
    <section className="page" aria-label="通知">
      <div className="page-body">
        <h1 className="page-title">通知</h1>
        <p className="muted">
          窗口收在托盘或不在前台时，用 Windows
          通知提醒需要你知道的事；点通知回到对应的会话。正在看的会话不会重复提醒。
        </p>
        <div className="card">
          <Row title="开启通知" detail="关闭后既不弹出系统通知，也不记入通知列表">
            <Switch
              label="开启通知"
              checked={notify.enabled}
              onChange={(enabled) => set({ enabled })}
            />
          </Row>
          <Row title="提示音" detail="弹出系统通知时播放 Windows 的通知声音">
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
      </div>
    </section>
  );
}

function About({
  version,
  service,
  adapterName,
  updates,
}: {
  version: string;
  service: string | null;
  adapterName: string;
  updates: MenuItem[];
}) {
  return (
    <section className="page" aria-label="关于与更新">
      <div className="page-body">
        <h1 className="page-title">关于与更新</h1>
        <div className="card">
          <Row title="客户端版本">
            <span className="setting-value">{version || '浏览器开发入口'}</span>
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
            detail="服务端跟随发布页；客户端的安装包由所连接的服务端提供，下载校验后覆盖升级"
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
        {project.url && (
          <button type="button" className="button" onClick={openProject}>
            <GithubMark />
            项目主页 · {project.name}
          </button>
        )}
      </div>
    </section>
  );
}

// Settings in one place, sorted by whose they are: Claude Code's own (kept on the cloud host) and this
// client's (kept on this computer).
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
}: {
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
}) {
  const [search, setSearch] = useState('');
  const term = search.trim().toLowerCase();
  const shown = sections.filter((item) =>
    `${item.name} ${item.words}`.toLowerCase().includes(term),
  );
  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand">设置</span>
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
            <section className="page" aria-label="Claude Code 设置">
              <div className="page-body">
                <h1 className="page-title">Claude Code</h1>
                <p className="muted">离线模拟没有 Claude Code 设置；连接远程代理后在这里修改。</p>
              </div>
            </section>
          )
        ) : section === 'general' ? (
          <General
            form={form}
            changeForm={changeForm}
            workspaceRoot={workspaceRoot}
            chooseWorkspace={chooseWorkspace}
          />
        ) : section === 'notifications' ? (
          <Notices />
        ) : section === 'help' ? (
          <Help />
        ) : (
          <About version={version} service={service} adapterName={adapterName} updates={updates} />
        )}
      </main>
    </>
  );
}
