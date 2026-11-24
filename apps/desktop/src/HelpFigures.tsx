import {
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  FolderOpen,
  Laptop,
  Monitor,
  Plus,
  Server,
  Smartphone,
  SquareTerminal,
  X,
} from 'lucide-react';
import type { Figure as Name } from './help-content.ts';
import { modes } from './PermissionMenu.tsx';

// Pictures for the help, drawn with the window's own colours and shapes so that they look like what the user will
// meet: the computers around the service, an approval card, the mode menu, a terminal. Names are the user's own
// where the window knows them.
export default function Figure({
  name,
  here,
  others,
  browser = false,
}: {
  name: Name;
  here: string;
  others: string[];
  browser?: boolean;
}) {
  const other = others[0] ?? '另一台电脑';
  switch (name) {
    case 'map':
      return <DeviceMap here={browser ? null : here} others={others} />;
    case 'approval':
      return (
        <Approval
          tool="Bash"
          command="npm install --save-dev vitest"
          device={here}
          note={`在 ${here} 上执行`}
        />
      );
    case 'remote-approval':
      return (
        <Approval
          tool="Bash"
          command={`ssh device-${slug(other)}-pwsh  # Remove-Item .\\build -Recurse`}
          device={other}
          note={`在 ${other} 上执行`}
        />
      );
    case 'modes':
      return (
        <div className="fig fig-modes" aria-hidden="true">
          <p className="fig-menu-heading">Claude Code 操作前如何征求同意？</p>
          {modes.map(({ value, name: label, detail, icon: Icon }, index) => (
            <div className={`fig-mode${index === 0 ? ' current' : ''}`} key={value}>
              <Icon />
              <span>
                <strong>
                  {label}
                  {index === 0 && <em>默认</em>}
                </strong>
                <small>{detail}</small>
              </span>
              {index === 0 && <Check className="fig-mode-check" />}
            </div>
          ))}
        </div>
      );
    case 'terminal':
      return (
        <div className="fig fig-terminal" aria-hidden="true">
          <div className="fig-terminal-bar">
            <i />
            <i />
            <i />
            <span>终端</span>
          </div>
          <pre>
            <span className="t-dim">PS D:\work\web-app&gt; </span>
            <span className="t-cmd">ccdt</span>
            {'\n'}
            <span className="t-dim">项目 web-app · 会话「修复登录页」</span>
            {'\n\n'}
            <span className="t-accent">✻</span> Claude Code
            {'\n'}
            <span className="t-dim">────────────────────────────────</span>
            {'\n'}
            <span className="t-you">&gt; 接着把登录页的测试补上</span>
            {'\n'}
            <span className="t-accent">●</span> 好的，先看看现有的测试……
          </pre>
        </div>
      );
    case 'agents':
      return (
        <div className="fig fig-agents" aria-hidden="true">
          <p className="fig-flow-label">其他 agent 把任务交给 Claude</p>
          <div className="fig-flow">
            <div className="fig-box">
              <Code2 />
              <strong>其他 agent · 脚本 · 编辑器</strong>
              <small>Codex、Gemini CLI、Zed……</small>
            </div>
            <div className="fig-arrow">
              <code>ccdt -p</code>
              <code>ccdt acp</code>
              <ArrowRight />
            </div>
            <div className="fig-box accent">
              <Server />
              <strong>服务端上的 Claude</strong>
              <small>普通会话，这里看得到</small>
            </div>
          </div>
          <p className="fig-flow-label">Claude 调用其他 agent</p>
          <div className="fig-flow">
            <div className="fig-box accent">
              <Server />
              <strong>Claude</strong>
              <small>在你的会话里</small>
            </div>
            <div className="fig-arrow">
              <code>codex exec</code>
              <ArrowRight />
            </div>
            <div className="fig-box">
              <Bot />
              <strong>电脑上的命令行 agent</strong>
              <small>一次性完成的子任务</small>
            </div>
          </div>
        </div>
      );
    case 'cache':
      return (
        <div className="fig fig-cache" aria-hidden="true">
          <div className="fig-cache-track">
            <span className="warm" />
            <span className="cold" />
            <i className="fig-cache-mark start" style={{ left: '0%' }} />
            <i className="fig-cache-mark compact" style={{ left: '62%' }} />
            <i className="fig-cache-mark expire" style={{ left: '72%' }} />
          </div>
          <div className="fig-cache-labels">
            <span style={{ left: '0%' }}>最后一条消息</span>
            <span className="compact" style={{ left: '62%' }}>
              自动压缩
            </span>
            <span className="expire" style={{ left: '72%' }}>
              约 1 小时 · 缓存过期
            </span>
          </div>
          <p className="fig-cache-note">过期后的第一条消息，要按全价重读整段上下文。</p>
        </div>
      );
    case 'quota':
      return (
        <div className="fig fig-quota" aria-hidden="true">
          <p className="fig-quota-title">同样的用量，计入 5 小时额度（社区实测）</p>
          <div className="fig-quota-row">
            <span>
              <Monitor /> 图形客户端
            </span>
            <div className="fig-quota-bar">
              <i style={{ width: '84%' }} />
            </div>
            <b>约 2×</b>
          </div>
          <div className="fig-quota-row">
            <span>
              <SquareTerminal /> ccdt
            </span>
            <div className="fig-quota-bar">
              <i className="lean" style={{ width: '42%' }} />
            </div>
            <b>1×</b>
          </div>
          <p className="fig-quota-note">每周额度不受影响。</p>
        </div>
      );
    case 'devices':
      return (
        <div className="fig fig-sidebar" aria-hidden="true">
          <div className="fig-side-row heading">
            <Laptop />
            <strong>其他设备</strong>
            <ChevronDown className="end" />
          </div>
          <div className="fig-side-row device">
            <ChevronDown />
            <span>{other}</span>
            <em className="online">在线</em>
          </div>
          <div className="fig-side-row project hover">
            <FolderOpen />
            <span>web-app</span>
            <Plus className="end fig-pulse" />
          </div>
          <div className="fig-side-row session">修复登录页</div>
          <div className="fig-side-row device">
            <ChevronRight />
            <span>{others[1] ?? 'nas'}</span>
            <em className="online">在线</em>
          </div>
          <div className="fig-side-row device off">
            <ChevronRight />
            <span>家里的笔记本</span>
            <em>离线</em>
          </div>
          <p className="fig-side-tip">悬停项目点 +，会话就在那台电脑上执行</p>
        </div>
      );
  }
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'office-pc';

function Approval({
  tool,
  command,
  device,
  note,
}: {
  tool: string;
  command: string;
  device: string;
  note: string;
}) {
  return (
    <div className="fig fig-approval" aria-hidden="true">
      <div className="fig-approval-title">
        <SquareTerminal />
        等待审批 <code>{tool}</code>
        <span className="fig-device">
          <Laptop />
          {device}
        </span>
      </div>
      <div className="fig-approval-card">
        <div className="fig-approval-copy">
          <Copy />
          复制工具输入
        </div>
        <code className="fig-approval-command">{command}</code>
        <div className="fig-approval-foot">
          <small>{note}</small>
          <span className="fig-pill">
            <X />
            拒绝
          </span>
          <span className="fig-pill solid">
            <Check />
            允许
          </span>
        </div>
      </div>
    </div>
  );
}

function DeviceMap({ here, others }: { here: string | null; others: string[] }) {
  const shown = others.slice(0, here ? 2 : 3);
  return (
    <div className="fig fig-map" aria-hidden="true">
      <div className="fig-map-server">
        <Server />
        <strong>你的服务器</strong>
        <small>Claude Code · 会话 · 记忆 · 账号</small>
      </div>
      <div className="fig-map-wire">
        <span>加密通道</span>
      </div>
      <div className="fig-map-devices">
        {here && (
          <div className="fig-map-device here">
            <Monitor />
            <span>
              <strong>{here}</strong>
              <small>这台电脑 · 项目和命令在这里</small>
            </span>
          </div>
        )}
        {shown.map((name) => (
          <div className="fig-map-device" key={name}>
            <Laptop />
            <span>
              <strong>{name}</strong>
              <small>在线</small>
            </span>
          </div>
        ))}
        {shown.length === 0 && (
          <div className="fig-map-device ghost">
            <Laptop />
            <span>
              <strong>另一台电脑</strong>
              <small>装客户端，登录同一个服务端</small>
            </span>
          </div>
        )}
        <div className={`fig-map-device${here ? '' : ' here'}`}>
          <Smartphone />
          <span>
            <strong>{here ? '手机 · 浏览器' : '这个浏览器'}</strong>
            <small>看进度、审批、追加指示</small>
          </span>
        </div>
      </div>
    </div>
  );
}
