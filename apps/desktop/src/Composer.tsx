import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CornerDownLeft,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  GitBranch,
  HelpCircle,
  ImagePlus,
  Laptop,
  MessageSquare,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  Shrink,
  Square,
} from 'lucide-react';
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
import type { MenuPosition } from './ui.tsx';
import { AttachmentCards } from './AttachmentCards.tsx';
import type { Attachment } from './attachments.ts';

export type Scenario = 'chat' | 'tool' | 'question' | 'error';
// A draft that is only a slash and an optional command name opens the command menu.
const slashDraft = /^[/\\][^ \n]*$/;
const compactDraft = /^[/\\](compact)?$/;

const scenarioItems: {
  value: Scenario;
  name: string;
  detail: string;
  icon: typeof MessageSquare;
}[] = [
  { value: 'chat', name: '对话', detail: '正常流式回复与多轮对话', icon: MessageSquare },
  { value: 'tool', name: '工具审批', detail: '模拟工具调用并等待允许或拒绝', icon: ShieldAlert },
  { value: 'question', name: '提问', detail: '模拟向你提问并等待回答', icon: HelpCircle },
  { value: 'error', name: '上游错误', detail: '模拟本轮运行报错中断', icon: AlertTriangle },
];

function useMenuDismiss(open: boolean, setOpen: (open: boolean) => void) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open, setOpen]);
  return container;
}

function ScenarioMenu({
  scenario,
  disabled,
  onChange,
}: {
  scenario: Scenario;
  disabled: boolean;
  onChange: (scenario: Scenario) => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useMenuDismiss(open, setOpen);
  const current = scenarioItems.find((item) => item.value === scenario) ?? scenarioItems[0];
  return (
    <div className="permission-control" ref={container}>
      <select
        className="sr-select"
        tabIndex={-1}
        aria-label="模拟场景"
        value={scenario}
        onChange={(event) => onChange(event.target.value as Scenario)}
        disabled={disabled}
      >
        {scenarioItems.map((item) => (
          <option key={item.value} value={item.value}>
            {item.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="chip"
        title="模拟场景"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <current.icon />
        <span>{current.name}</span>
        <ChevronDown />
      </button>
      {open && (
        <div className="permission-menu toolbar-menu" role="menu" aria-label="模拟场景菜单">
          <p className="menu-heading">模拟运行场景</p>
          {scenarioItems.map(({ value, name, detail, icon: Icon }) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={value === scenario}
              key={value}
              onClick={() => {
                setOpen(false);
                if (value !== scenario) onChange(value);
              }}
            >
              <Icon />
              <span className="menu-label">
                {name}
                <small>{detail}</small>
              </span>
              {value === scenario && <Check className="menu-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SessionModelSelect({
  provider,
  model,
  capabilities,
  openaiModels,
  disabled,
  onSelect,
}: {
  provider: 'claude' | 'openai';
  model: string | null;
  capabilities: NativeCapabilities | null;
  openaiModels: { id: string; displayName: string }[];
  disabled: boolean;
  onSelect: (provider: 'claude' | 'openai', model: string | null) => void;
}) {
  const claudeList = capabilities?.models.filter((row) => row.value !== 'default') ?? [];
  const customClaude =
    provider !== 'openai' &&
    model &&
    !claudeList.some((row) => row.value === model || row.resolvedModel === model)
      ? model
      : null;
  const customOpenAI =
    provider === 'openai' && model && !openaiModels.some((row) => row.id === model) ? model : null;

  return (
    <select
      className="sr-select"
      tabIndex={-1}
      aria-label="会话模型"
      value={`${provider}:${model ?? ''}`}
      disabled={disabled}
      onChange={(event) => {
        const value = event.target.value;
        const split = value.indexOf(':');
        const nextProvider = value.slice(0, split) === 'openai' ? 'openai' : 'claude';
        const nextModel = value.slice(split + 1) || null;
        onSelect(nextProvider, nextModel);
      }}
    >
      <optgroup label="Claude">
        <option value="claude:">默认</option>
        {claudeList.map((row) => (
          <option key={row.value} value={`claude:${row.value}`}>
            {row.displayName}
          </option>
        ))}
        {customClaude && <option value={`claude:${customClaude}`}>{customClaude}</option>}
      </optgroup>
      <optgroup label="OpenAI">
        <option value="openai:">默认</option>
        {openaiModels.map((row) => (
          <option key={row.id} value={`openai:${row.id}`}>
            {row.displayName}
          </option>
        ))}
        {customOpenAI && <option value={`openai:${customOpenAI}`}>{customOpenAI}</option>}
      </optgroup>
    </select>
  );
}

function formatMatchPath(fullPath: string, projectRoot: string) {
  const name = fullPath.split(/[\\/]/).at(-1) ?? fullPath;
  const normFull = fullPath.replace(/\\/g, '/');
  const normRoot = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  let rel = normFull;
  if (normRoot && normFull.toLowerCase().startsWith(normRoot.toLowerCase() + '/')) {
    rel = normFull.slice(normRoot.length + 1);
  }
  const slash = rel.lastIndexOf('/');
  const dir = slash > 0 ? rel.slice(0, slash) : '';
  return { name, dir };
}

function matchFileIcon(filePath: string) {
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filePath)) return <FileImage size={15} />;
  if (
    /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|c|cc|cpp|h|hpp|cs|java|json|ya?ml|toml|sh|ps1|bat|css|html|sql|vue|svelte)$/i.test(
      filePath,
    )
  )
    return <FileCode2 size={15} />;
  return <FileText size={15} />;
}

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
  chooseProject,
  draft,
  setDraft,
  attachments,
  setAttachments,
  native,
  connected,
  busy,
  refreshing,
  canRefreshModels,
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
  quota,
  projectBusy,
  openaiModels,
  openAccount,
  send,
  resume,
  compact,
  refresh,
  configure,
  stop,
}: {
  session: Session;
  // Absent for a session that belongs to no project.
  projectName: string | null;
  // Opens the list of projects the session can be moved to; absent while it cannot be moved.
  chooseProject?: (position: MenuPosition) => void;
  draft: string;
  setDraft: (text: string) => void;
  attachments: Attachment[];
  setAttachments: (items: Attachment[], text?: string) => void;
  native: boolean;
  connected: boolean;
  busy: boolean;
  refreshing: boolean;
  canRefreshModels: boolean;
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
  // Set while a quota window is at the reminder line, or past the line that pauses sending.
  quota: { level: 'warn' | 'stop'; text: string } | null;
  // Another session on this project is running. Sending stays allowed.
  projectBusy: boolean;
  openaiModels: { id: string; displayName: string }[];
  openAccount: () => void;
  send: () => void;
  // Present when the session's last turn was stopped or cut off: takes it up again without a message.
  resume?: () => void;
  compact: () => void;
  refresh: () => void;
  configure: (values: {
    model?: string | null;
    effort?: Effort | null;
    permissionMode?: PermissionMode;
    provider?: 'claude' | 'openai';
  }) => Promise<void>;
  stop: () => void;
}) {
  const projectTools = session.provider !== 'openai';
  const localFiles = Boolean(window.desktop);
  const commands = session.provider === 'openai' || (projectTools && native);
  const input = useRef<HTMLTextAreaElement>(null);
  const branch = useBranch(session.projectPath, !!session.activeRun);
  const [dropping, setDropping] = useState(false);
  const [matches, setMatches] = useState<string[]>([]);
  const [matchIndex, setMatchIndex] = useState(0);
  const matchList = useRef<HTMLDivElement>(null);
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(
    null,
  );
  useEffect(() => {
    setMention(null);
    setMatches([]);
  }, [session.id]);
  useEffect(() => {
    if (!window.desktop || !mention) {
      setMatches([]);
      return;
    }
    let current = true;
    const timer = setTimeout(
      () =>
        void window
          .desktop!.searchFiles(session.projectPath, mention.query)
          .then((items) => {
            if (current) setMatches(items);
          })
          .catch(() => {
            if (current) setMatches([]);
          }),
      180,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [mention, session.projectPath]);
  useEffect(() => {
    setMatchIndex(0);
  }, [matches]);
  useEffect(() => {
    const list = matchList.current;
    const selected = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !selected) return;
    const top = selected.offsetTop;
    const bottom = top + selected.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight)
      list.scrollTop = bottom - list.clientHeight;
  }, [matchIndex, matches]);
  useLayoutEffect(() => {
    // Grow with the draft; the stylesheet's max-height decides when scrolling takes over.
    if (!input.current) return;
    input.current.style.height = 'auto';
    input.current.style.height = `${input.current.scrollHeight}px`;
  }, [draft, session.id]);
  // A file reaches Claude as its Windows path in the message: Claude reads it through the execution channel,
  // the same way it reads the project.
  function attach(paths: string[], text?: string) {
    if (!paths.length) return;
    const unique = [
      ...new Set([...latestAttachments.current.map((item) => item.path), ...paths]),
    ].slice(0, 40);
    setAttachments(
      unique.map((path) => ({ path })),
      text,
    );
    input.current?.focus();
  }
  const latestAttachments = useRef(attachments);
  latestAttachments.current = attachments;
  function chooseMatch(path: string) {
    if (!mention) return;
    const nextText = draft.slice(0, mention.start) + draft.slice(mention.end);
    attach([path], nextText);
    setMention(null);
    setMatches([]);
  }
  const shown = useRef(session.id);
  shown.current = session.id;
  // Files copied in Explorer have a path. A picture that is only on the clipboard (a screenshot, an image
  // copied from a page) has none: the client saves it on this computer and its path is attached like any other.
  async function paste(files: File[]) {
    const pasted = session.id;
    const found: string[] = [];
    for (const file of files) {
      const path = window.desktop!.pathForFile(file);
      if (path) found.push(path);
      else if (file.type.startsWith('image/'))
        try {
          found.push(
            await window.desktop!.saveImage(file.type, new Uint8Array(await file.arrayBuffer())),
          );
        } catch {
          // A picture that could not be saved is left out; the rest is still attached.
        }
    }
    if (shown.current === pasted) attach(found);
  }
  const openFilePicker = () => {
    const id = session.id;
    void window.desktop!.chooseFiles().then((paths) => {
      if (shown.current === id) attach(paths);
    });
  };
  return (
    <div className="composer-area">
      {commands && slashOpen && (
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
          {projectTools && (
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
          )}
        </div>
      )}
      <div className="composer-context">
        <button
          type="button"
          className="chip quiet"
          aria-label="会话所在的项目"
          aria-haspopup="menu"
          title={session.projectPath}
          disabled={!chooseProject}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            chooseProject!({ x: box.left, y: box.top - 6, above: true });
          }}
        >
          <Folder />
          <span>{projectName ?? '普通会话'}</span>
        </button>
        {branch && (
          <span className="chip quiet" title="项目当前所在的 git 分支">
            <GitBranch />
            <span>{branch}</span>
          </span>
        )}
      </div>
      {quota && (
        <p
          className={`quota-notice ${quota.level}`}
          role={quota.level === 'stop' ? 'alert' : 'status'}
        >
          {quota.text}
        </p>
      )}
      {projectBusy && (
        <p className="quota-notice" role="status">
          这个项目还有会话在运行。两个会话可能同时改同一个文件，不会自动合并。
        </p>
      )}
      <form
        className={`composer ${dropping ? 'dropping' : ''}`}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        onDragOver={(event) => {
          if (
            !localFiles ||
            inputDisabled ||
            !event.dataTransfer.types.includes('Files')
          )
            return;
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          setDropping(false);
          if (!localFiles || inputDisabled || !event.dataTransfer.files.length)
            return;
          event.preventDefault();
          void paste([...event.dataTransfer.files]);
        }}
      >
        <AttachmentCards
          items={attachments}
          remove={(path) => setAttachments(attachments.filter((item) => item.path !== path))}
        />
        {localFiles && mention && matches.length > 0 && (
          <div className="attachment-matches" role="listbox" aria-label="项目文件" ref={matchList}>
            {matches.map((path, index) => {
              const { name, dir } = formatMatchPath(path, session.projectPath);
              const selected = index === Math.min(matchIndex, matches.length - 1);
              return (
                <button
                  type="button"
                  key={path}
                  role="option"
                  aria-selected={selected}
                  title={path}
                  onMouseEnter={() => setMatchIndex(index)}
                  onClick={() => chooseMatch(path)}
                >
                  <span className="attachment-match-icon" aria-hidden="true">
                    {matchFileIcon(path)}
                  </span>
                  <span className="attachment-match-name">{name}</span>
                  {dir && <small className="attachment-match-dir">{dir}</small>}
                </button>
              );
            })}
          </div>
        )}
        <div className="composer-input-box">
          <textarea
            ref={input}
            aria-label="消息"
            placeholder="输入任务或问题…"
            value={draft}
            disabled={inputDisabled}
            maxLength={16000}
            rows={1}
            onChange={(event) => {
              setDraft(event.target.value);
              setSlashOpen(commands && slashDraft.test(event.target.value));
              const before = event.target.value.slice(0, event.target.selectionStart);
              const match = localFiles ? /(?:^|\s)@([^\s@]*)$/.exec(before) : null;
              setMention(
                match
                  ? { start: before.lastIndexOf('@'), end: before.length, query: match[1] }
                  : null,
              );
            }}
            onPaste={(event) => {
              // Pasted text is left to the browser, also when a program put a picture of it beside the text.
              if (!localFiles || !event.clipboardData.files.length) return;
              const files = [...event.clipboardData.files];
              const text = event.clipboardData.getData('text/plain');
              const usable = files.filter(
                (file) =>
                  window.desktop!.pathForFile(file) || (!text && file.type.startsWith('image/')),
              );
              if (!usable.length) return;
              event.preventDefault();
              void paste(usable);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setMention(null);
                setMatches([]);
                setSlashOpen(false);
                return;
              }
              if (
                mention &&
                matches.length > 0 &&
                (event.key === 'ArrowDown' || event.key === 'ArrowUp')
              ) {
                event.preventDefault();
                const direction = event.key === 'ArrowDown' ? 1 : -1;
                setMatchIndex((current) => (current + direction + matches.length) % matches.length);
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (mention && matches.length > 0) {
                  chooseMatch(matches[Math.min(matchIndex, matches.length - 1)]);
                  return;
                }
                if (slashOpen && compactDraft.test(draft)) compact();
                else send();
              }
            }}
          />
          <div className="composer-box-actions">
            {session.activeRun && session.activeRun.waiting !== 'background' && (
              <IconButton
                title="停止运行"
                className="stop-button"
                disabled={!connected || !ownsRun || busy}
                onClick={stop}
              >
                <Square />
              </IconButton>
            )}
            {resume && !draft.trim() && !attachments.length ? (
              <IconButton title="接着上一轮继续" className="send-button" onClick={resume}>
                <Play />
              </IconButton>
            ) : (
              (!session.activeRun || native || session.provider === 'openai') && (
                <button
                  type="submit"
                  className="icon-button send-button"
                  aria-label="发送消息"
                  title={quota?.level === 'stop' ? quota.text : '发送消息'}
                  disabled={
                    (!draft.trim() && !attachments.length) ||
                    inputDisabled ||
                    quota?.level === 'stop'
                  }
                >
                  <CornerDownLeft />
                </button>
              )
            )}
          </div>
        </div>
        <div className="composer-toolbar">
          {localFiles && (
            <IconButton
              title="添加文件卡片：发送时附上本机路径"
              className="attach-button"
              disabled={inputDisabled}
              onClick={openFilePicker}
            >
              <Plus />
            </IconButton>
          )}
          {projectTools && !native ? (
            <ScenarioMenu
              scenario={scenario}
              disabled={!!session.activeRun || busy}
              onChange={setScenario}
            />
          ) : (
            <PermissionMenu
              mode={session.permissionMode}
              disabled={controlsDisabled}
              who={session.provider === 'openai' ? 'Codex' : 'Claude Code'}
              change={(permissionMode) => void configure({ permissionMode })}
            />
          )}
          <SessionModelSelect
            provider={session.provider === 'openai' ? 'openai' : 'claude'}
            model={session.model}
            capabilities={capabilities}
            openaiModels={openaiModels}
            disabled={controlsDisabled}
            onSelect={(provider, model) =>
              void configure({
                provider,
                model,
                ...(provider === session.provider ? {} : { effort: null }),
              })
            }
          />
          <span className="toolbar-space" />
          <ComposerControls
            key={session.id}
            provider={session.provider === 'openai' ? 'openai' : 'claude'}
            model={session.model}
            effort={session.effort}
            capabilities={capabilities}
            nativeSession={nativeSession}
            metrics={metrics}
            openAccount={openAccount}
            disabled={controlsDisabled}
            configure={configure}
            refresh={refresh}
            refreshing={refreshing}
            canRefreshModels={canRefreshModels}
            openaiModels={openaiModels}
          />
        </div>
      </form>
    </div>
  );
}
