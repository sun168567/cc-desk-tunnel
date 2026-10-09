import {
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
  Plus,
  Search,
  SquareTerminal,
  Wrench,
  X,
} from 'lucide-react';
import type { Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import { describe, duration, summarize } from './activity.ts';
import type { Category } from './activity.ts';
import type { HistoryState } from './client.ts';
import QuestionCard, { questionsOf } from './QuestionCard.tsx';
import { conversation } from './transcript.ts';
import type { TranscriptItem, Turn, Work } from './transcript.ts';
import { CopyButton, copyText } from './copy.tsx';
import { messageTime } from './messageTime.ts';
import ConversationFind, { SearchExpanded } from './ConversationFind.tsx';
import { IconButton, Menu } from './ui.tsx';
import type { MenuItem, MenuPosition } from './ui.tsx';

const RichText = lazy(() => import('./RichText.tsx'));
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
  summary,
  children,
}: {
  className: string;
  forced?: boolean;
  summary: React.ReactNode;
  children: () => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
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
  const { category, verb, subject, added, removed, running, failed } = describe(tool, active);
  const Icon = icons[category];
  const approval = live.canApprove(tool);
  // A question Claude asks is answered, not allowed or denied.
  const questions = tool.name === 'AskUserQuestion' ? questionsOf(tool.input) : null;
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
      summary={
        <span className="tool-heading">
          {running ? <LoaderCircle className="spinning" /> : <Icon />}
          <span className="tool-verb">{verb}</span>
          <span className="tool-subject" title={subject}>
            {subject}
          </span>
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
        <div className="tool-detail">
          <CopyButton text={tool.input} label="复制工具输入" />
          <pre className="tool-input" data-search-content>
            {tool.input}
          </pre>
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

function Message({
  item,
  native,
  edit,
}: {
  item: Text;
  native: boolean;
  edit?: (item: Text) => void;
}) {
  const time = messageTime(item.at);
  return (
    <article className={`message ${item.kind}`}>
      <div className="message-label">
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
        {item.kind === 'user' ? '你' : native ? 'Claude Code' : 'CC Desk Tunnel'}
        {item.kind === 'assistant' && !native && <span>模拟</span>}
        {item.kind === 'user' && item.delivery && <span>{item.delivery}</span>}
        {time && (
          <time className="message-time" dateTime={item.at} title={time.full}>
            {time.short}
          </time>
        )}
        <CopyButton text={item.text} />
      </div>
      <div className="message-content" data-search-content data-copy-text={item.text}>
        {item.kind === 'user' ? <p>{item.text}</p> : <Rich text={item.text} />}
      </div>
    </article>
  );
}

function TurnView({ turn, native, live }: { turn: Turn; native: boolean; live: Live }) {
  const active = !turn.endedAt;
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
        <Message key={step.id} item={step} native={native} />
      ),
    );
  return (
    <>
      {turn.question && (
        <Message item={turn.question} native={native} edit={turn.joined ? undefined : live.edit} />
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
                </span>
              }
            >
              {steps}
            </Fold>
          )}
      {turn.answer && <Message item={turn.answer} native={native} />}
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
    </>
  );
}

export default function Conversation({
  session,
  events,
  history,
  connected,
  native,
  ownsRun,
  busy,
  newSession,
  loadEarlier,
  replyApproval,
  stopTask,
  stop,
  edit,
  findRequest,
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
}) {
  const turns = useMemo(() => conversation(events), [events]);
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
          <div className="empty-state">
            <MessageSquare />
            <h2>新会话</h2>
            <button
              type="button"
              className="button primary"
              disabled={!connected}
              onClick={newSession}
            >
              <Plus />
              新建会话
            </button>
          </div>
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
              <div className="empty-state">
                <MessageSquare />
                <h2>{session.title}</h2>
                <span className="empty-project">{session.projectPath}</span>
              </div>
            )}
            {turns.map((turn) => (
              <TurnView key={turn.id} turn={turn} native={native} live={live} />
            ))}
            {session.activeRun && background && (
              <div className="background-tasks">
                <div className="run-indicator" role="status">
                  <span className="running-dot" />
                  后台任务{tasks.length ? ` ${tasks.length} 个` : ''} · Claude
                  已答完，任务结束后会接着处理
                  {!ownsRun && ' · 另一连接'}
                </div>
                <ul>
                  {tasks.map((task) => (
                    <li key={task.id}>
                      <span>{task.description || task.kind}</span>
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
            {session.activeRun && !background && (
              <div className="run-indicator" role="status">
                <span className="running-dot" />
                {session.activeRun.status !== 'awaiting_approval'
                  ? '运行中'
                  : session.activeRun.waiting === 'question'
                    ? '等待回答'
                    : '等待审批'}
                {!ownsRun && ' · 另一连接'}
              </div>
            )}
          </div>
        )}
      </div>
      {contextMenu && (
        <Menu label="对话文字操作" {...contextMenu} onClose={() => setContextMenu(null)} />
      )}
    </SearchExpanded.Provider>
  );
}
