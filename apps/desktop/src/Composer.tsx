import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Folder, GitBranch, Plus, RefreshCw, Shrink, Square } from 'lucide-react';
import type {
  Effort,
  NativeCapabilities,
  NativeMetrics,
  NativeSession,
  PermissionMode,
  Session,
} from '@cc-desk-tunnel/protocol';
import ComposerControls from './ComposerControls.tsx';
import PermissionMenu from './PermissionMenu.tsx';
import { IconButton } from './ui.tsx';

export type Scenario = 'chat' | 'tool' | 'error';
// A draft that is only a slash and an optional command name opens the command menu.
const slashDraft = /^[/\\][^ \n]*$/;
const compactDraft = /^[/\\](compact)?$/;

// The branch the project's working tree is on, read from the project by the desktop; it is looked at again
// whenever the window comes back to the front or a run ends, the moments it may have changed.
function useBranch(path: string, running: boolean) {
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    if (!window.desktop) return;
    let current = true;
    const read = () =>
      void window.desktop!.gitBranch(path).then(
        (value) => current && setBranch(value),
        () => current && setBranch(null),
      );
    read();
    window.addEventListener('focus', read);
    return () => {
      current = false;
      window.removeEventListener('focus', read);
    };
  }, [path, running]);
  return branch;
}

export default function Composer({
  session,
  projectName,
  draft,
  setDraft,
  native,
  connected,
  busy,
  refreshing,
  ownsRun,
  inputDisabled,
  controlsDisabled,
  slashOpen,
  setSlashOpen,
  canCompact,
  scenario,
  setScenario,
  capabilities,
  nativeSession,
  metrics,
  send,
  compact,
  refresh,
  configure,
  stop,
}: {
  session: Session;
  // Absent for a session that belongs to no project.
  projectName: string | null;
  draft: string;
  setDraft: (text: string) => void;
  native: boolean;
  connected: boolean;
  busy: boolean;
  refreshing: boolean;
  ownsRun: boolean;
  inputDisabled: boolean;
  controlsDisabled: boolean;
  slashOpen: boolean;
  setSlashOpen: (open: boolean) => void;
  canCompact: boolean;
  scenario: Scenario;
  setScenario: (scenario: Scenario) => void;
  capabilities: NativeCapabilities | null;
  nativeSession: NativeSession | null;
  metrics: NativeMetrics | null;
  send: () => void;
  compact: () => void;
  refresh: () => void;
  configure: (values: {
    model?: string | null;
    effort?: Effort | null;
    permissionMode?: PermissionMode;
  }) => Promise<void>;
  stop: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const branch = useBranch(session.projectPath, !!session.activeRun);
  const [dropping, setDropping] = useState(false);
  useLayoutEffect(() => {
    // Grow with the draft; the stylesheet's max-height decides when scrolling takes over.
    if (!input.current) return;
    input.current.style.height = 'auto';
    input.current.style.height = `${input.current.scrollHeight}px`;
  }, [draft, session.id]);
  // A file reaches Claude as its Windows path in the message: Claude reads it through the execution channel,
  // the same way it reads the project.
  function attach(paths: string[]) {
    if (!paths.length) return;
    const box = input.current;
    const at = box ? box.selectionStart : draft.length;
    const before = draft.slice(0, at);
    const text = paths.map((path) => `"${path}"`).join(' ');
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    setDraft(`${before}${lead}${text} ${draft.slice(at)}`);
    box?.focus();
  }
  const paths = (files: FileList) =>
    [...files].map((file) => window.desktop!.pathForFile(file)).filter(Boolean);
  return (
    <div className="composer-area">
      {native && slashOpen && (
        <div className="slash-menu" role="listbox" aria-label="会话命令">
          <button
            type="button"
            role="option"
            aria-selected={true}
            disabled={controlsDisabled || !canCompact}
            onClick={compact}
          >
            <Shrink />
            <span>
              压缩上下文
              <small>
                {metrics?.context ? `已使用 ${metrics.context.percentage}%` : '/compact'}
              </small>
            </span>
          </button>
          <button
            type="button"
            role="option"
            aria-selected={false}
            disabled={controlsDisabled || refreshing}
            onClick={() => {
              setSlashOpen(false);
              setDraft('');
              refresh();
            }}
          >
            <RefreshCw />
            <span>
              刷新原生状态<small>上下文与订阅额度</small>
            </span>
          </button>
        </div>
      )}
      <div className="composer-context">
        <span className="chip quiet" title={session.projectPath}>
          <Folder />
          <span>{projectName ?? '普通会话'}</span>
        </span>
        {branch && (
          <span className="chip quiet" title="项目当前所在的 git 分支">
            <GitBranch />
            <span>{branch}</span>
          </span>
        )}
      </div>
      <form
        className={`composer ${dropping ? 'dropping' : ''}`}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        onDragOver={(event) => {
          if (!window.desktop || inputDisabled || !event.dataTransfer.types.includes('Files'))
            return;
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          setDropping(false);
          if (!window.desktop || inputDisabled || !event.dataTransfer.files.length) return;
          event.preventDefault();
          attach(paths(event.dataTransfer.files));
        }}
      >
        <textarea
          ref={input}
          aria-label="消息"
          placeholder="随心输入…"
          value={draft}
          disabled={inputDisabled}
          maxLength={16000}
          rows={2}
          onChange={(event) => {
            setDraft(event.target.value);
            setSlashOpen(native && slashDraft.test(event.target.value));
          }}
          onPaste={(event) => {
            // Files copied in Explorer arrive as files; pasted text is left to the browser.
            if (!window.desktop || !event.clipboardData.files.length) return;
            const found = paths(event.clipboardData.files);
            if (!found.length) return;
            event.preventDefault();
            attach(found);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setSlashOpen(false);
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (slashOpen && compactDraft.test(draft)) compact();
              else send();
            }
          }}
        />
        <div className="composer-toolbar">
          {window.desktop && (
            <IconButton
              title="添加文件：把文件的路径放进消息"
              className="attach-button"
              disabled={inputDisabled}
              onClick={() => void window.desktop!.chooseFiles().then(attach)}
            >
              <Plus />
            </IconButton>
          )}
          {!native ? (
            <label className="scenario-label">
              场景
              <select
                aria-label="模拟场景"
                value={scenario}
                onChange={(event) => setScenario(event.target.value as Scenario)}
                disabled={!!session.activeRun || busy}
              >
                <option value="chat">对话</option>
                <option value="tool">工具审批</option>
                <option value="error">上游错误</option>
              </select>
            </label>
          ) : (
            <PermissionMenu
              mode={session.permissionMode}
              disabled={controlsDisabled}
              change={(permissionMode) => void configure({ permissionMode })}
            />
          )}
          <span className="toolbar-space" />
          {native && (
            <ComposerControls
              key={session.id}
              model={session.model}
              effort={session.effort}
              capabilities={capabilities}
              nativeSession={nativeSession}
              metrics={metrics}
              disabled={controlsDisabled}
              configure={configure}
            />
          )}
          {session.activeRun && (
            <IconButton
              title="停止运行"
              className="stop-button"
              disabled={!connected || !ownsRun || busy}
              onClick={stop}
            >
              <Square />
            </IconButton>
          )}
          {(!session.activeRun || native) && (
            <button
              type="submit"
              className="icon-button send-button"
              aria-label="发送消息"
              title="发送消息"
              disabled={!draft.trim() || inputDisabled}
            >
              <ArrowUp />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
