import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowUpToLine,
  Bot,
  Brain,
  Check,
  ChevronRight,
  FilePen,
  FileText,
  Globe,
  LoaderCircle,
  MessageSquare,
  Pencil,
  Search,
  SquareTerminal,
  Wrench,
  X,
} from 'lucide-react';
import { Claude, OpenAI } from '@lobehub/icons';
import type { Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import { describe, duration, summarize } from './activity.ts';
import type { Category } from './activity.ts';
import type { HistoryState, TaskProgress } from './client.ts';
import { RunStatus, TaskLine } from './RunStatus.tsx';
import type { Clock } from './RunStatus.tsx';
import QuestionCard, { questionsOf } from './QuestionCard.tsx';
import { conversation } from './transcript.ts';
import type { TranscriptItem, Turn, Work } from './transcript.ts';
import { CopyButton, copyText } from './copy.tsx';
import { AttachmentCards, useMessageAttachments } from './AttachmentCards.tsx';
import { splitUserMessage } from './attachments.ts';
import { messageTime } from './messageTime.ts';
import TurnStats from './TurnStats.tsx';
import ConversationFind, { SearchExpanded } from './ConversationFind.tsx';
import { IconButton, Menu } from './ui.tsx';
import type { MenuItem, MenuPosition } from './ui.tsx';
import { countChanges, parseEditInput } from './edit-input.ts';
import LocalChanges from './LocalChanges.tsx';
import { isFilePath } from './file-mentions.ts';
import { documentKind, FileLookup, OpenDocument } from './file-preview.ts';
import type { ProxyClient } from './client.ts';
import WelcomeHero from './WelcomeHero.tsx';

const CodeDiff = lazy(() => import('./CodeDiff.tsx'));

const RichText = lazy(() => import('./RichText.tsx'));
const ExpandFiles = createContext(0);
const Rich = ({ text }: { text: string }) => (
  <Suspense fallback={<p>{text}</p>}>
    <RichText text={text} />
  </Suspense>
);

type Tool = Extract<TranscriptItem, { kind: 'tool' }>;
type Text = Extract<TranscriptItem, { kind: 'user' | 'assistant' | 'thinking' }>;
// What the rows need from the session: the clock for running timers and how to answer an approval.
type Live = {
  now: number;
  busy: boolean;
  canApprove: (tool: Tool) => boolean;
  reply: (tool: Tool, allowed: boolean, answers?: Record<string, string>) => void;
  // Absent while a fork cannot be made.
  edit?: (item: Text) => void;
};
const icons: Record<Category, typeof Wrench> = {
  command: SquareTerminal,
  edit: FilePen,
  read: FileText,
  search: Search,
  web: Globe,
  agent: Bot,
  other: Wrench,
};

// A fold that the reader controls, except while something inside needs an answer.
function Fold({
  className,
  forced = false,
  initialOpen = false,
  summary,
  children,
}: {
  className: string;
  forced?: boolean;
  initialOpen?: boolean;
  summary: React.ReactNode;
  children: () => React.ReactNode;
}) {
  const [open, setOpen] = useState(initialOpen);
  const expandFiles = useContext(ExpandFiles);
  useEffect(() => {
    if (expandFiles) setOpen(true);
  }, [expandFiles]);
  const searching = useContext(SearchExpanded);
  const shown = open || forced || searching;
  return (
    <details className={className} open={shown}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          if (!forced && !searching) setOpen(!open);
        }}
      >
        <ChevronRight className="fold-chevron" />
        {summary}
      </summary>
      {shown && children()}
    </details>
  );
}

function ToolRow({ tool, active, live }: { tool: Tool; active: boolean; live: Live }) {
  const openDocument = useContext(OpenDocument);
  const { category, verb, subject, added, removed, running, failed } = describe(tool, active);
  const Icon = icons[category];
  const approval = live.canApprove(tool);
  // A question Claude asks is answered, not allowed or denied.
  const questions = tool.name === 'AskUserQuestion' ? questionsOf(tool.input) : null;
  const editInput = category === 'edit' ? parseEditInput(tool.name, tool.input) : null;
  if (approval && questions)
    return (
      <QuestionCard
        questions={questions}
        busy={live.busy}
        answer={(answers) => live.reply(tool, true, answers)}
        skip={() => live.reply(tool, false)}
      />
    );
  return (
    <Fold
      className={`tool ${failed ? 'failed' : ''}`}
      forced={approval}
      initialOpen={category === 'edit'}
      summary={
        <span className="tool-heading">
          {running ? <LoaderCircle className="spinning" /> : <Icon />}
          <span className="tool-verb">{verb}</span>
          {editInput && documentKind(editInput.path) ? (
            <button
              type="button"
              className="tool-subject"
              title={`${editInput.path}\n在右侧预览`}
              onClick={(event) => {
                event.stopPropagation();
                event.preventDefault();
                openDocument({
                  path: editInput.path,
                  fallback: editInput.changes.map((change) => change.newText).join('\n'),
                });
              }}
            >
              {subject}
            </button>
          ) : (
            <span className="tool-subject" title={subject}>
              {subject}
            </span>
          )}
          {(added > 0 || removed > 0) && (
            <span className="tool-diff">
              <ins>+{added}</ins>
              <del>−{removed}</del>
            </span>
          )}
          <span className="tool-time">
            {tool.target === 'Windows (simulation)' && '模拟 · '}
            {tool.endedAt
              ? duration(tool.at, tool.endedAt)
              : running && duration(tool.at, live.now)}
          </span>
        </span>
      }
    >
      {() => (
        <div className={`tool-detail${editInput ? '' : ' plain'}`}>
          {editInput ? (
            <Suspense
              fallback={
                <pre data-search-content>
                  {editInput.changes.map((change) => change.newText).join('\n')}
                </pre>
              }
            >
              <CodeDiff input={editInput} />
            </Suspense>
          ) : (
            <>
              <CopyButton text={tool.input} label="复制工具输入" />
              <pre className="tool-input" data-search-content>
                {tool.input}
              </pre>
            </>
          )}
          {tool.liveOutput && !tool.output && (
            <pre className="tool-output" data-search-content>
              {tool.liveOutput}
            </pre>
          )}
          {tool.output && (
            <>
              <CopyButton text={tool.output} label="复制工具输出" />
              <pre className="tool-output" data-search-content>
                {tool.exitCode !== null &&
                  tool.exitCode !== undefined &&
                  `退出码 ${tool.exitCode}\n`}
                {tool.output}
              </pre>
            </>
          )}
          {approval && (
            <div className="approval-actions">
              <button
                type="button"
                className="button secondary"
                disabled={live.busy}
                onClick={() => live.reply(tool, false)}
              >
                <X />
                拒绝
              </button>
              <button
                type="button"
                className="button primary"
                disabled={live.busy}
                onClick={() => live.reply(tool, true)}
              >
                <Check />
                允许
              </button>
            </div>
          )}
        </div>
      )}
    </Fold>
  );
}

function WorkGroup({
  work,
  active,
  latest,
  live,
}: {
  work: Work;
  active: boolean;
  latest: boolean;
  live: Live;
}) {
  const { label, waiting, running, started, ended } = summarize(work, active, latest);
  return (
    <Fold
      className="work"
      forced={waiting}
      summary={
        <span className="work-heading">
          {running && <LoaderCircle className="spinning" />}
          <span>{label}</span>
          {!waiting && <small>{duration(started, ended && !running ? ended : live.now)}</small>}
        </span>
      }
    >
      {() =>
        work.items.map((item) =>
          item.kind === 'tool' ? (
            <ToolRow key={item.id} tool={item} active={active} live={live} />
          ) : (
            <Fold
              key={item.id}
              className="tool thinking-block"
              summary={
                <span className="tool-heading">
                  <Brain />
                  <span className="tool-verb">思考</span>
                </span>
              }
            >
              {() => (
                <div className="message-content tool-detail" data-search-content>
                  <Rich text={item.text} />
                </div>
              )}
            </Fold>
          ),
        )
      }
    </Fold>
  );
}

function UserMessage({ item, edit }: { item: Text; edit?: (item: Text) => void }) {
  const time = messageTime(item.at);
  const stored = useMessageAttachments(item.id);
  const { bodyText, attachments } = splitUserMessage(item.text, stored);
  const showAttachments = !!window.desktop && attachments.length > 0;
  const visibleText = showAttachments ? bodyText : item.text;

  return (
    <article className="message user">
      <div className="user-message-container">
        {showAttachments && <AttachmentCards items={attachments} stored />}
        {visibleText && (
          <div className="user-message-bubble" data-search-content data-copy-text={item.text}>
            <p>{visibleText}</p>
          </div>
        )}
        <div
          className="message-toolbar user-toolbar"
          data-search-content={!visibleText ? true : undefined}
          data-copy-text={!visibleText ? item.text : undefined}
        >
          {time && (
            <time className="message-time" dateTime={item.at} title={time.full}>
              {time.short}
            </time>
          )}
          {item.delivery && <span className="message-delivery">{item.delivery}</span>}
          {edit && (
            <button
              type="button"
              className="message-action"
              aria-label="编辑重发"
              title="编辑重发：从这条消息之前分叉出新会话，原会话保留"
              onClick={() => edit(item)}
            >
              <Pencil />
            </button>
          )}
          <CopyButton text={item.text} label="复制" />
        </div>
      </div>
    </article>
  );
}

function Message({
  item,
  native,
  provider,
  edit,
}: {
  item: Text;
  native: boolean;
  provider?: 'claude' | 'openai';
  edit?: (item: Text) => void;
}) {
  if (item.kind === 'user') {
    return <UserMessage item={item} edit={edit} />;
  }

  const time = messageTime(item.at);

  return (
    <article className={`message ${item.kind}`}>
      <div className="message-content" data-search-content data-copy-text={item.text}>
        {item.kind === 'thinking' ? <p>{item.text}</p> : <Rich text={item.text} />}
      </div>
      <div className="message-toolbar assistant-toolbar">
        {item.kind === 'assistant' &&
          (provider === 'openai' ? (
            <OpenAI size={13} className="assistant-claude-mark" />
          ) : (
            <Claude.Color size={13} className="assistant-claude-mark" />
          ))}
        {item.kind === 'assistant' && !native && <span className="chip quiet">模拟</span>}
        {time && (
          <time className="message-time" dateTime={item.at} title={time.full}>
            {time.short}
          </time>
        )}
        <CopyButton text={item.text} label="复制" />
      </div>
    </article>
  );
}

function TurnView({
  turn,
  native,
  provider,
  live,
}: {
  turn: Turn;
  native: boolean;
  provider?: 'claude' | 'openai';
  live: Live;
}) {
  const [jump, setJump] = useState({ path: '', request: 0 });
  const root = useRef<HTMLDivElement>(null);
  const openDocument = useContext(OpenDocument);
  const files = new Map<string, { added: number; removed: number; fallback: string }>();
  for (const step of turn.steps) {
    if (step.kind !== 'work') continue;
    for (const tool of step.items) {
      if (tool.kind !== 'tool') continue;
      const parsed = parseEditInput(tool.name, tool.input);
      if (!parsed) continue;
      const count = countChanges(parsed);
      const previous = files.get(parsed.path);
      const written = parsed.changes
        .map((change) => change.newText)
        .filter(Boolean)
        .join('\n');
      files.set(parsed.path, {
        added: count.added + (previous?.added ?? 0),
        removed: count.removed + (previous?.removed ?? 0),
        fallback: written || previous?.fallback || '',
      });
    }
  }
  useEffect(() => {
    const host = root.current;
    if (!host || !jump.path) return;
    const locate = () => {
      const panel = [...host.querySelectorAll<HTMLElement>('[data-file-path]')].find(
        (el) => el.dataset.filePath === jump.path,
      );
      if (!panel) return false;
      panel.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return true;
    };
    if (locate()) return;
    const observer = new MutationObserver(() => {
      if (locate()) observer.disconnect();
    });
    observer.observe(host, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [jump]);
  const active = !turn.endedAt;
  const notes = turn.steps.filter((step) => step.kind === 'assistant').length;
  const steps = () =>
    turn.steps.map((step, index) =>
      step.kind === 'work' ? (
        <WorkGroup
          key={step.id}
          work={step}
          active={active}
          latest={index === turn.steps.length - 1}
          live={live}
        />
      ) : (
        <Message key={step.id} item={step} native={native} provider={provider} />
      ),
    );
  return (
    <ExpandFiles.Provider value={jump.request}>
      <div ref={root} className="conversation-turn">
        {turn.question?.continued ? (
          <div className="run-notice" role="status">
            {turn.question.text}
          </div>
        ) : (
          turn.question && (
            <Message
              item={turn.question}
              native={native}
              provider={provider}
              edit={turn.joined ? undefined : live.edit}
            />
          )
        )}
        {active
          ? steps()
          : turn.steps.length > 0 && (
              <Fold
                className="turn-process"
                summary={
                  <span>
                    用时 {duration(turn.startedAt, turn.endedAt!)}
                    {turn.tools > 0 && ` · ${turn.tools} 步`}
                    {notes > 0 && ` · ${notes} 条说明`}
                  </span>
                }
              >
                {steps}
              </Fold>
            )}
        {turn.answer && <Message item={turn.answer} native={native} provider={provider} />}
        {files.size > 0 && (
          <div className="changed-files" aria-label="本轮文件改动">
            <span>本轮文件改动</span>
            {[...files].map(([path, count]) => (
              <button
                type="button"
                key={path}
                title={documentKind(path) ? `${path}\n在右侧预览` : path}
                onClick={() => {
                  setJump((current) => ({ path, request: current.request + 1 }));
                  if (documentKind(path)) openDocument({ path, fallback: count.fallback });
                }}
              >
                <span>{path}</span>
                <ins>+{count.added}</ins>
                <del>−{count.removed}</del>
              </button>
            ))}
          </div>
        )}
        <LocalChanges turn={turn} omit={[...files.keys()].sort().join('\0')} />
        {turn.stats && <TurnStats stats={turn.stats} />}
        {turn.notices.map((item) => (
          <div
            key={item.id}
            className={`run-notice ${item.error ? 'failed' : ''}`}
            role={item.error ? 'alert' : 'status'}
            data-search-content
          >
            {item.text}
          </div>
        ))}
      </div>
    </ExpandFiles.Provider>
  );
}

export default function Conversation({
  session,
  events,
  history,
  connected,
  native,
  ownsRun,
  clock,
  progress,
  busy,
  newSession,
  loadEarlier,
  replyApproval,
  stopTask,
  stop,
  edit,
  findRequest,
  client,
  accountName = '',
  allSessions = [],
}: {
  session: Session | undefined;
  events: SessionEvent[];
  history: HistoryState | undefined;
  connected: boolean;
  native: boolean;
  ownsRun: boolean;
  busy: boolean;
  newSession: () => void;
  loadEarlier: () => Promise<void>;
  findRequest: number;
  client?: ProxyClient;
  accountName?: string;
  allSessions?: Session[];
  // Ends one background task of the run, or the run with all of them.
  stopTask: (taskId: string) => void;
  stop: () => void;
  replyApproval: (
    runId: string,
    approvalId: string,
    allowed: boolean,
    answers?: Record<string, string>,
  ) => void;
  edit?: (messageId: string, text: string) => void;
  clock: Clock;
  // What the session's background tasks last said of themselves, by task.
  progress: Record<string, TaskProgress> | undefined;
}) {
  const turns = useMemo(() => conversation(events), [events]);
  const fileLookup = useMemo(() => {
    const knownPaths = new Map<string, string>();
    const projectPath = session?.projectPath ?? '';
    const normRoot = projectPath.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
    const recordPath = (candidate: unknown) => {
      if (typeof candidate !== 'string') return;
      const trimmed = candidate.trim();
      if (!isFilePath(trimmed)) return;
      const base = (trimmed.split(/[\\/]/).pop() ?? '').toLowerCase();
      if (base) knownPaths.set(base, trimmed);
      const norm = trimmed.replaceAll('\\', '/').toLowerCase();
      if (normRoot && norm.startsWith(normRoot + '/')) {
        knownPaths.set(norm.slice(normRoot.length + 1), trimmed);
      }
    };
    for (const turn of turns) {
      for (const step of turn.steps) {
        if (step.kind !== 'work') continue;
        for (const item of step.items) {
          if (item.kind !== 'tool') continue;
          const edit = parseEditInput(item.name, item.input);
          if (edit?.path) recordPath(edit.path);
          try {
            const raw = JSON.parse(item.input);
            if (raw && typeof raw === 'object') {
              recordPath(raw.file_path);
              recordPath(raw.notebook_path);
              recordPath(raw.path);
            }
          } catch {}
        }
      }
    }
    return { projectPath, knownPaths };
  }, [turns, session?.projectPath]);
  const toolAtWork = !!turns
    .at(-1)
    ?.steps.flatMap((step) => (step.kind === 'work' ? step.items : []))
    .some((item) => item.kind === 'tool' && item.state === 'running');
  // A task has been waited for since the run first listed it.
  const listedAt = (taskId: string) =>
    Date.parse(
      events.find(
        (event) =>
          event.runId === session?.activeRun?.id &&
          event.payload.type === 'native.tasks' &&
          event.payload.tasks.some((task) => task.id === taskId),
      )?.createdAt ?? '',
    ) || clock.now();
  const background = session?.activeRun?.waiting === 'background';
  const tasks = useMemo(() => {
    const last = events.findLast(
      (event) => event.payload.type === 'native.tasks' && event.runId === session?.activeRun?.id,
    )?.payload;
    return last?.type === 'native.tasks' ? last.tasks : [];
  }, [events, session?.activeRun?.id]);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [loadError, setLoadError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [contextMenu, setContextMenu] = useState<(MenuPosition & { items: MenuItem[] }) | null>(
    null,
  );
  const transcriptRoot = useRef<HTMLDivElement>(null);
  const lastFindRequest = useRef(findRequest);
  const searching = findOpen && query.length > 0;
  const openFind = () => {
    follow.current = false;
    setFindOpen(true);
  };
  useEffect(() => {
    setFindOpen(false);
    setQuery('');
    setLoadError('');
    setContextMenu(null);
    setCopyStatus('');
  }, [session?.id]);
  useEffect(() => {
    if (!copyStatus) return;
    const timer = setTimeout(() => setCopyStatus(''), 2000);
    return () => clearTimeout(timer);
  }, [copyStatus]);
  useEffect(() => {
    if (findRequest !== lastFindRequest.current) openFind();
    lastFindRequest.current = findRequest;
  }, [findRequest]);
  // Running timers tick once a second, and only while something runs.
  const [now, setNow] = useState(Date.now);
  const running = !!session?.activeRun;
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const live: Live = {
    now,
    busy,
    canApprove: (tool) =>
      connected &&
      ownsRun &&
      session?.activeRun?.id === tool.runId &&
      !tool.resolved &&
      !!tool.approvalId,
    reply: (tool, allowed, answers) =>
      replyApproval(tool.runId, tool.approvalId!, allowed, answers),
    edit: edit && !running ? (item) => edit(item.id, item.text) : undefined,
  };
  const scroll = useRef<HTMLDivElement>(null);
  // The view follows new output while the reader stays near the bottom.
  const follow = useRef(true);
  // Earlier history is inserted above; the anchor keeps the lines being read where they were.
  const prependAnchor = useRef<{ sessionId: string; height: number; top: number } | null>(null);
  const lastTop = useRef(0);
  const loadMore = () => {
    if (!session || !connected || !history?.hasEarlier || history.loadingEarlier || history.loading)
      return;
    setLoadError('');
    if (scroll.current)
      prependAnchor.current = {
        sessionId: session.id,
        height: scroll.current.scrollHeight,
        top: scroll.current.scrollTop,
      };
    void loadEarlier().catch(() => setLoadError('更早记录加载失败，请重试'));
  };
  useLayoutEffect(() => {
    prependAnchor.current = null;
    follow.current = true;
    scroll.current?.scrollTo(0, scroll.current.scrollHeight);
  }, [session?.id]);
  useLayoutEffect(() => {
    const anchor = prependAnchor.current;
    if (anchor && anchor.sessionId === session?.id && !history?.loadingEarlier && scroll.current) {
      scroll.current.scrollTop = anchor.top + scroll.current.scrollHeight - anchor.height;
      prependAnchor.current = null;
      follow.current = false;
      return;
    }
    if (anchor) return;
    if (follow.current && !findOpen) scroll.current?.scrollTo(0, scroll.current.scrollHeight);
  }, [events, history?.loadingEarlier, session?.id]);

  return (
    <FileLookup.Provider value={fileLookup}>
      <SearchExpanded.Provider value={searching}>
      {session && (
        <div className="conversation-tools">
          <span role="status">{copyStatus}</span>
          <IconButton title="打开对话查找" onClick={openFind}>
            <Search />
          </IconButton>
        </div>
      )}
      {findOpen && session && (
        <ConversationFind
          root={transcriptRoot}
          scroll={scroll}
          query={query}
          change={setQuery}
          request={findRequest}
          partial={!!history?.hasEarlier}
          close={() => {
            setFindOpen(false);
            setQuery('');
            scroll.current?.focus();
          }}
        />
      )}
      <div
        className={`conversation ${searching ? 'searching' : ''}`}
        tabIndex={-1}
        ref={scroll}
        onContextMenu={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest('input, textarea, [contenteditable="true"]')) return;
          event.preventDefault();
          const selection = window.getSelection()?.toString() ?? '';
          const message = target.closest<HTMLElement>('[data-copy-text]');
          const block = target.closest('pre');
          const copy = (text: string) => {
            void copyText(text).then(
              () => setCopyStatus('已复制'),
              () => setCopyStatus('复制失败，请重试'),
            );
          };
          setContextMenu({
            x: event.clientX,
            y: event.clientY,
            items: [
              { label: '复制选中文字', disabled: !selection, run: () => copy(selection) },
              ...(block
                ? [{ label: '复制此代码块', run: () => copy(block.textContent ?? '') }]
                : []),
              ...(message
                ? [{ label: '复制整条消息', run: () => copy(message.dataset.copyText ?? '') }]
                : []),
              {
                label: '全选对话文字',
                run: () => {
                  if (!transcriptRoot.current) return;
                  const range = document.createRange();
                  range.selectNodeContents(transcriptRoot.current);
                  const selected = window.getSelection();
                  selected?.removeAllRanges();
                  selected?.addRange(range);
                },
              },
              { label: '查找对话内容', separated: true, run: openFind },
            ],
          });
        }}
        onScroll={() => {
          if (!scroll.current) return;
          const top = scroll.current.scrollTop;
          follow.current = scroll.current.scrollHeight - top - scroll.current.clientHeight < 80;
          // Reading on upwards past what is loaded brings the page before it; a failed load waits for the button.
          if (top < lastTop.current && top < 240 && !loadError) loadMore();
          lastTop.current = top;
        }}
        onWheel={(event) => {
          // A loaded page shorter than the window cannot scroll, so the wheel itself asks for more.
          if (event.deltaY < 0 && scroll.current?.scrollTop === 0 && !loadError) loadMore();
        }}
      >
        {!session ? (
          <WelcomeHero
            connected={connected}
            accountName={accountName}
            onNewSession={newSession}
            client={client}
            sessions={allSessions}
          />
        ) : (
          <div className="transcript" ref={transcriptRoot}>
            {loadError && (
              <div className="history-status" role="alert">
                {loadError}
              </div>
            )}
            {history?.hasEarlier && (
              <button
                type="button"
                className="history-load"
                disabled={!connected || history.loadingEarlier || history.loading}
                onClick={loadMore}
              >
                <ArrowUpToLine />
                {history.loadingEarlier ? '加载中' : '加载更早记录'}
              </button>
            )}
            {history?.loading && (
              <div className="history-status" role="status">
                同步会话
              </div>
            )}
            {turns.length === 0 && !history?.loading && (
              <WelcomeHero
                sessionTitle={session.title}
                projectPath={session.projectPath}
                provider={session.provider}
                client={client}
                sessions={allSessions}
              />
            )}
            {turns.map((turn) => (
              <TurnView
                key={turn.id}
                turn={turn}
                native={native}
                provider={session.provider}
                live={live}
              />
            ))}
            {session.activeRun && background && (
              <div className="background-tasks">
                <div className="run-indicator" role="status">
                  <span className={`running-dot${connected ? ' breathing' : ''}`} />
                  {session.provider === 'openai'
                    ? `进行中的命令${tasks.length ? ` ${tasks.length} 条` : ''} · 可以单独结束这一条`
                    : `后台任务${tasks.length ? ` ${tasks.length} 个` : ''} · Claude 已答完，任务结束后会接着处理`}
                  {!ownsRun && ' · 另一连接'}
                </div>
                <ul>
                  {tasks.map((task) => (
                    <li key={task.id}>
                      <span>
                        {task.description || task.kind}
                        <TaskLine
                          since={listedAt(task.id)}
                          progress={progress?.[task.id]}
                          clock={clock}
                          connected={connected}
                        />
                      </span>
                      <button
                        type="button"
                        className="button"
                        disabled={!connected || !ownsRun || busy}
                        onClick={() => stopTask(task.id)}
                      >
                        结束
                      </button>
                    </li>
                  ))}
                </ul>
                {tasks.length !== 1 && (
                  <button
                    type="button"
                    className="button"
                    disabled={!connected || !ownsRun || busy}
                    onClick={stop}
                  >
                    全部结束
                  </button>
                )}
              </div>
            )}
            {session.activeRun &&
              !background &&
              (session.activeRun.status !== 'awaiting_approval' ? (
                <RunStatus
                  tool={toolAtWork}
                  since={Math.max(
                    clock.activityAt(session.id),
                    Date.parse(events.at(-1)?.createdAt ?? '') || 0,
                  )}
                  clock={clock}
                  connected={connected}
                  suffix={ownsRun ? '' : ' · 另一连接'}
                  provider={session.provider}
                />
              ) : (
                <div className="run-indicator" role="status">
                  <span className="running-dot" />
                  {session.activeRun.waiting === 'question' ? '等待回答' : '等待审批'}
                  {!ownsRun && ' · 另一连接'}
                </div>
              ))}
          </div>
        )}
      </div>
      {contextMenu && (
        <Menu label="对话文字操作" {...contextMenu} onClose={() => setContextMenu(null)} />
      )}
      </SearchExpanded.Provider>
    </FileLookup.Provider>
  );
}
