import {
  lazy,
  Suspense,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ArrowDown,
  ArrowUpToLine,
  Bot,
  Brain,
  Check,
  ChevronRight,
  FilePen,
  FileText,
  FoldVertical,
  Globe,
  Image as ImageIcon,
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
import type { HistoryState, TaskProgress } from './client.ts';
import { RunStatus, TaskLine, terminalState } from './RunStatus.tsx';
import type { Clock } from './RunStatus.tsx';
import QuestionCard, { questionsOf } from './QuestionCard.tsx';
import { conversation } from './transcript.ts';
import { usePrefs } from './prefs.ts';
import { firstLine } from './transcriptView.ts';
import type { Compact, Notice, TranscriptItem, Turn, Work } from './transcript.ts';
import { CopyButton, copyText } from './copy.tsx';
import { messageTime } from './messageTime.ts';
import TurnStats from './TurnStats.tsx';
import ConversationFind, { SearchExpanded } from './ConversationFind.tsx';
import { IconButton, Menu } from './ui.tsx';
import type { MenuItem, MenuPosition } from './ui.tsx';
import { LinkPlace, linkTarget } from './links.ts';
import type { Link } from './links.ts';
import { followLink, linkMenu } from './linkActions.ts';
import { pictureUrl, toolPictures } from './pictures.ts';
import { Picture } from './Picture.tsx';

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
  // This window has answered the approval and waits for the service to take it: a second press would be
  // a second answer.
  answered: (tool: Tool) => boolean;
  reply: (tool: Tool, allowed: boolean, answers?: Record<string, string>) => void;
  // The foreground task a running call waits on, while this window may act on it: 'sent' once it has, until
  // the call returns.
  taskControl: (tool: Tool) => 'ready' | 'sent' | undefined;
  endTool: (tool: Tool) => void;
  backgroundTool: (tool: Tool) => void;
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
  // Given whether the fold is open, for a heading that shows what the open fold would show twice.
  summary: React.ReactNode | ((shown: boolean) => React.ReactNode);
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
        {typeof summary === 'function' ? summary(shown) : summary}
      </summary>
      {shown && children()}
    </details>
  );
}

// What a link leads to, beside it: shown while the pointer rests on the link, and after a click with what came of
// it (a note), so that why a path cannot be opened is read where it was clicked.
type LinkCard = { top: number; left: number; above: boolean; link: Link; note?: string };
function LinkCardView({ card }: { card: LinkCard }) {
  const { link, note } = card;
  const target =
    link.kind === 'web'
      ? link.url
      : link.kind === 'path' && link.line
        ? `${link.path}:${link.line}`
        : link.path;
  const hint =
    link.kind === 'web'
      ? '点击在浏览器中打开 · 右键可复制地址'
      : link.kind === 'path'
        ? '点击打开 · 右键查看更多操作'
        : `${link.reason}右键可复制路径。`;
  return (
    <div
      className={`link-card${card.above ? ' above' : ''}`}
      role="tooltip"
      style={{ top: card.top, left: card.left }}
    >
      <span className="link-card-target">{target}</span>
      {note ? (
        <strong>{note}</strong>
      ) : (
        <small className={link.kind === 'elsewhere' ? 'link-card-warn' : undefined}>{hint}</small>
      )}
    </div>
  );
}

// What may be done with the task a running call waits on, in the call's line or in the heading of its shut group.
function TaskActions({
  tool,
  control,
  live,
}: {
  tool: Tool;
  control: 'ready' | 'sent';
  live: Live;
}) {
  return (
    <span className="tool-task-actions">
      <button
        type="button"
        className="button"
        disabled={control === 'sent' || live.busy}
        title="命令接着运行，Claude 不再等它，先做别的；命令结束后 Claude 会收到结果"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          live.backgroundTool(tool);
        }}
      >
        转后台
      </button>
      <button
        type="button"
        className="button"
        disabled={control === 'sent' || live.busy}
        title="只结束这一条，这一轮不停止，Claude 会接着处理"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          live.endTool(tool);
        }}
      >
        终止
      </button>
    </span>
  );
}

function ToolRow({ tool, active, live }: { tool: Tool; active: boolean; live: Live }) {
  const { category, verb, subject, added, removed, running, failed } = describe(tool, active);
  const Icon = icons[category];
  const pictures = useMemo(() => (tool.output ? toolPictures(tool.output) : null), [tool.output]);
  const approval = live.canApprove(tool);
  const control = live.taskControl(tool);
  // A question Claude asks is answered, not allowed or denied.
  const questions = tool.name === 'AskUserQuestion' ? questionsOf(tool.input) : null;
  if (approval && questions)
    return (
      <QuestionCard
        questions={questions}
        busy={live.busy || live.answered(tool)}
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
          {pictures && <ImageIcon className="tool-picture-mark" aria-label="含图片" />}
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
          {control && <TaskActions tool={tool} control={control} live={live} />}
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
          {pictures ? (
            <>
              {pictures.text && (
                <>
                  <CopyButton text={pictures.text} label="复制工具输出" />
                  <pre className="tool-output" data-search-content>
                    {pictures.text}
                  </pre>
                </>
              )}
              <div className="tool-pictures">
                {pictures.pictures.map((picture, index) => (
                  <Picture key={index} src={pictureUrl(picture)} alt={`图片 ${index + 1}`} />
                ))}
              </div>
            </>
          ) : (
            tool.output && (
              <>
                <CopyButton text={tool.output} label="复制工具输出" />
                <pre className="tool-output" data-search-content>
                  {tool.exitCode !== null &&
                    tool.exitCode !== undefined &&
                    `退出码 ${tool.exitCode}\n`}
                  {tool.output}
                </pre>
              </>
            )
          )}
          {approval && (
            <div className="approval-actions">
              <button
                type="button"
                className="button secondary"
                disabled={live.busy || live.answered(tool)}
                onClick={() => live.reply(tool, false)}
              >
                <X />
                拒绝
              </button>
              <button
                type="button"
                className="button primary"
                disabled={live.busy || live.answered(tool)}
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

// The calls and thoughts of a run, one under another.
function WorkItems({
  work,
  active,
  live,
  preview,
}: {
  work: Work;
  active: boolean;
  live: Live;
  preview?: boolean;
}) {
  return (
    <>
      {work.items.map((item) =>
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
                {preview && <span className="thinking-preview">{firstLine(item.text)}</span>}
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
      )}
    </>
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
  // The one call of the group waited on in the foreground can be acted on without opening it; several are acted on
  // in their own lines.
  const controlled = work.items.filter(
    (item): item is Tool => item.kind === 'tool' && !!live.taskControl(item),
  );
  const control = controlled.length === 1 ? live.taskControl(controlled[0]) : undefined;
  return (
    <Fold
      className="work"
      forced={waiting}
      summary={(shown) => (
        <span className="work-heading">
          {running && <LoaderCircle className="spinning" />}
          <span>{label}</span>
          {!waiting && <small>{duration(started, ended && !running ? ended : live.now)}</small>}
          {control && !shown && <TaskActions tool={controlled[0]} control={control} live={live} />}
        </span>
      )}
    >
      {() => <WorkItems work={work} active={active} live={live} />}
    </Fold>
  );
}

// No message has a heading; what belongs to it is in a line under it, shown while the pointer is over the message. Under
// a question: how it was delivered, its time, editing and copy, at the right like the question. Under the reply that
// closes a turn: copy, the turn's figures and the time, always shown on the latest. Replies said along the way have
// nothing under them. A delivery that did not plainly arrive stays in sight. Replies of the simulated service keep the
// heading, which says they are not real.
function Message({
  item,
  native,
  edit,
  footer,
  closing = false,
  latest = false,
  joined = false,
}: {
  item: Text;
  native: boolean;
  edit?: (item: Text) => void;
  footer?: ReactNode;
  closing?: boolean;
  latest?: boolean;
  // A question put in while the run went on.
  joined?: boolean;
}) {
  const time = messageTime(item.kind === 'assistant' ? (item.doneAt ?? item.at) : item.at);
  const user = item.kind === 'user';
  const stamp = time && (
    <time className="message-time" dateTime={item.at} title={time.full}>
      {time.short}
    </time>
  );
  return (
    <article className={`message ${item.kind}${latest ? ' latest' : ''}${joined ? ' joined' : ''}`}>
      {!user && !native && (
        <div className="message-label">
          CC Desk Tunnel
          <span>模拟</span>
          {stamp}
          <CopyButton text={item.text} />
        </div>
      )}
      <div className="message-content" data-search-content data-copy-text={item.text}>
        {user ? <p>{item.text}</p> : <Rich text={item.text} />}
      </div>
      {user && (
        <div className="message-footer">
          {item.terminal && (
            <span className="message-delivery" title="在终端里问的，随终端的进展记入这个会话">
              终端
            </span>
          )}
          {item.delivery && (
            <span
              className={`message-delivery${item.delivery === '原生已接收' ? '' : ' unsettled'}`}
            >
              {item.delivery}
            </span>
          )}
          {stamp}
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
          <CopyButton text={item.text} />
        </div>
      )}
      {!user && native && closing && (
        <div className="message-footer">
          <CopyButton text={item.text} />
          {footer}
          {stamp}
        </div>
      )}
    </article>
  );
}

// A compaction of the context, in its place among the steps: under way with its timer, then what it compacted.
function CompactMark({ item, active, now }: { item: Compact; active: boolean; now: number }) {
  const running = active && !item.endedAt;
  const timed = running || (item.endedAt && item.endedAt !== item.at);
  return (
    <div className={`compact-mark${running ? ' running' : ''}`} role="status">
      <span>
        {running ? <LoaderCircle className="spinning" /> : <FoldVertical />}
        {running
          ? '正在压缩上下文'
          : !item.endedAt
            ? '上下文压缩未完成'
            : item.trigger === 'auto'
              ? '上下文已自动压缩'
              : '上下文已压缩'}
        {item.previousTokens != null && ` · 压缩前 ${item.previousTokens.toLocaleString()} tokens`}
        {timed && ` · ${duration(item.at, item.endedAt ?? now)}`}
      </span>
    </div>
  );
}

function NoticeLine({ item }: { item: Notice }) {
  const error = item.kind === 'notice' && item.error;
  return (
    <div
      className={`run-notice ${error ? 'failed' : ''}`}
      role={error ? 'alert' : 'status'}
      data-search-content
    >
      {item.text}
    </div>
  );
}

// How long a turn took, without the time it stood stopped before it was taken up again.
const spent = (turn: Turn) => duration(turn.startedAt, Date.parse(turn.endedAt!) - turn.pausedMs);

// A question put in while the run goes on closes the turn before it, but the run has not finished: that turn and the
// ones joined to it stay as they were until it has.
function heldOpen(turns: Turn[], index: number) {
  let last = index;
  while (turns[last + 1]?.joined) last++;
  return last > index && !turns[last].endedAt;
}

function TurnView({
  turn,
  native,
  live,
  latest,
  held,
}: {
  turn: Turn;
  native: boolean;
  live: Live;
  latest: boolean;
  held: boolean;
}) {
  const active = !turn.endedAt;
  const expanded = usePrefs().view.mode === 'expanded';
  const notes = turn.steps.filter((step) => step.kind === 'assistant').length;
  // A turn of nothing but a compaction, as /compact makes, has nothing to fold away.
  const folds = turn.steps.some((step) => step.kind === 'work' || step.kind === 'assistant');
  const steps = () =>
    turn.steps.map((step, index) =>
      step.kind === 'compact' ? (
        <CompactMark key={step.id} item={step} active={active} now={live.now} />
      ) : step.kind === 'notice' || step.kind === 'note' ? (
        <NoticeLine key={step.id} item={step} />
      ) : step.kind === 'work' ? (
        expanded ? (
          <div key={step.id} className="work-flat">
            <WorkItems work={step} active={active} live={live} preview />
          </div>
        ) : (
          <WorkGroup
            key={step.id}
            work={step}
            active={active}
            latest={index === turn.steps.length - 1}
            live={live}
          />
        )
      ) : (
        <Message key={step.id} item={step} native={native} />
      ),
    );
  return (
    <>
      {/* "Continue" without the turn it takes up, which is on an earlier page, shows nothing for itself. */}
      {turn.question && !turn.question.continued && (
        <Message
          item={turn.question}
          native={native}
          edit={turn.joined ? undefined : live.edit}
          joined={turn.joined}
        />
      )}
      {active || held || expanded || !folds
        ? steps()
        : turn.steps.length > 0 && (
            <Fold
              className="turn-process"
              summary={
                <span className={turn.outcome}>
                  {turn.outcome === 'cancelled' && '已停止 · '}
                  {turn.outcome === 'failed' && '处理失败 · '}
                  用时 {spent(turn)}
                  {turn.tools > 0 && ` · ${turn.tools} 步`}
                  {notes > 0 && ` · ${notes} 条说明`}
                </span>
              }
            >
              {steps}
            </Fold>
          )}
      {turn.answer ? (
        <Message
          item={turn.answer}
          native={native}
          closing
          latest={latest}
          footer={turn.stats && <TurnStats stats={turn.stats} />}
        />
      ) : (
        turn.stats &&
        turn.endedAt && (
          <div className={`message assistant${latest ? ' latest' : ''}`}>
            <div className="message-footer">
              <TurnStats stats={turn.stats} />
            </div>
          </div>
        )
      )}
      {turn.notices.map((item) => (
        <NoticeLine key={item.id} item={item} />
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
  clock,
  progress,
  busy,
  newSession,
  loadEarlier,
  replyApproval,
  stopTask,
  backgroundTask,
  stop,
  edit,
  findRequest,
  here,
}: {
  session: Session | undefined;
  // This window can open the files of the session's project: a desktop on the computer they are on.
  here: boolean;
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
  // Sends the foreground task a call waits on to the background.
  backgroundTask: (toolId: string) => void;
  stop: () => void;
  replyApproval: (
    runId: string,
    approvalId: string,
    allowed: boolean,
    answers?: Record<string, string>,
    // Whether the answer reached the service.
  ) => Promise<boolean>;
  edit?: (messageId: string, text: string) => void;
  clock: Clock;
  // What the session's background tasks last said of themselves, by task.
  progress: Record<string, TaskProgress> | undefined;
}) {
  const turns = useMemo(() => conversation(events), [events]);
  // A compaction under way counts its time in its own line, as a tool does.
  const steps = turns.at(-1)?.steps ?? [];
  const toolAtWork =
    steps.some((step) => step.kind === 'compact' && !step.endedAt) ||
    steps
      .flatMap((step) => (step.kind === 'work' ? step.items : []))
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
  const [contextMenu, setContextMenu] = useState<
    (MenuPosition & { heading?: string; items: MenuItem[] }) | null
  >(null);
  // Only the desktop opens files; a page in a browser may still count as on the computer for its runs.
  const place = useMemo(
    () =>
      session
        ? {
            projectPath: session.projectPath,
            here: here && !!window.desktop,
            browser: !window.desktop,
          }
        : null,
    [session?.projectPath, here],
  );
  const [linkCard, setLinkCard] = useState<LinkCard | null>(null);
  const resting = useRef<ReturnType<typeof setTimeout>>(undefined);
  const showLink = (element: Element, link: Link, note?: string) => {
    const box = element.getBoundingClientRect();
    const above = box.bottom + 110 > innerHeight;
    setLinkCard({
      top: above ? box.top - 6 : box.bottom + 6,
      left: Math.max(8, Math.min(box.left, innerWidth - 368)),
      above,
      link,
      note,
    });
  };
  const transcriptRoot = useRef<HTMLDivElement>(null);
  const lastFindRequest = useRef(findRequest);
  const searching = findOpen && query.length > 0;
  const openFind = () => {
    leave();
    setFindOpen(true);
  };
  useEffect(() => {
    setFindOpen(false);
    setQuery('');
    setLoadError('');
    setContextMenu(null);
    setCopyStatus('');
    setLinkCard(null);
  }, [session?.id]);
  // What came of a click stays a while, then goes.
  useEffect(() => {
    if (!linkCard?.note) return;
    const timer = setTimeout(() => setLinkCard(null), 4000);
    return () => clearTimeout(timer);
  }, [linkCard]);
  useEffect(() => {
    if (!copyStatus) return;
    // Longer words, such as why a link did not open, stay longer.
    const timer = setTimeout(() => setCopyStatus(''), Math.max(2000, copyStatus.length * 150));
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
  // Approvals answered from here, until the service has them; one it refused can be answered again. The
  // ref stops a second press before the page has drawn the first; the state greys the buttons out.
  const answering = useRef(new Set<string>());
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  // A press on a task's buttons holds them until the call returns; should nothing come of it, they are offered again.
  const [taskSent, setTaskSent] = useState<ReadonlySet<string>>(new Set());
  const sendTask = (toolId: string) => {
    setTaskSent((value) => new Set(value).add(toolId));
    setTimeout(
      () =>
        setTaskSent((value) => {
          const rest = new Set(value);
          rest.delete(toolId);
          return rest;
        }),
      5000,
    );
  };
  const live: Live = {
    now,
    busy,
    answered: (tool) => !!tool.approvalId && answered.has(tool.approvalId),
    canApprove: (tool) =>
      connected &&
      ownsRun &&
      session?.activeRun?.id === tool.runId &&
      !tool.resolved &&
      !!tool.approvalId,
    reply: (tool, allowed, answers) => {
      const id = tool.approvalId!;
      if (answering.current.has(id)) return;
      answering.current.add(id);
      setAnswered((value) => new Set(value).add(id));
      void replyApproval(tool.runId, id, allowed, answers).then((sent) => {
        if (sent) return;
        answering.current.delete(id);
        setAnswered((value) => {
          const rest = new Set(value);
          rest.delete(id);
          return rest;
        });
      });
    },
    edit: edit && !running ? (item) => edit(item.id, item.text) : undefined,
    taskControl: (tool) =>
      connected &&
      ownsRun &&
      session?.activeRun?.id === tool.runId &&
      tool.taskId &&
      !tool.endedAt &&
      // A command over in a moment is not worth buttons that would flash.
      now - Date.parse(tool.at) >= 3000
        ? taskSent.has(tool.id)
          ? 'sent'
          : 'ready'
        : undefined,
    endTool: (tool) => {
      sendTask(tool.id);
      stopTask(tool.taskId!);
    },
    backgroundTool: (tool) => {
      sendTask(tool.id);
      backgroundTask(tool.id);
    },
  };
  const scroll = useRef<HTMLDivElement>(null);
  // The view follows new output until the reader moves up from the end, and again once they come back down to it.
  const follow = useRef(true);
  // Shown while not following, as the way back to the end.
  const [away, setAway] = useState(false);
  // Earlier history is inserted above; the anchor keeps the lines being read where they were.
  const prependAnchor = useRef<{ sessionId: string; height: number; top: number } | null>(null);
  const lastTop = useRef(0);
  // What the view moved by itself is not the reader's: the next scroll event compares with where it was put.
  const toEnd = () => {
    if (!scroll.current) return;
    scroll.current.scrollTo(0, scroll.current.scrollHeight);
    lastTop.current = scroll.current.scrollTop;
  };
  const fromEnd = (box: HTMLElement) => box.scrollHeight - box.scrollTop - box.clientHeight;
  const leave = () => {
    follow.current = false;
    setAway(true);
  };
  const rejoin = () => {
    follow.current = true;
    setAway(false);
  };
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
    rejoin();
    toEnd();
  }, [session?.id]);
  useLayoutEffect(() => {
    const anchor = prependAnchor.current;
    if (anchor && anchor.sessionId === session?.id && !history?.loadingEarlier && scroll.current) {
      scroll.current.scrollTop = anchor.top + scroll.current.scrollHeight - anchor.height;
      lastTop.current = scroll.current.scrollTop;
      prependAnchor.current = null;
      leave();
      return;
    }
    if (anchor) return;
    if (follow.current && !findOpen) toEnd();
  }, [events, history?.loadingEarlier, session?.id]);
  // Heights keep changing after that scroll with nothing new said: a reply's Markdown drawn late, messages the page
  // had only estimated until they came into view (`content-visibility`), a resized window. While following, the
  // view keeps to the end through them.
  useEffect(() => {
    if (!scroll.current || !transcriptRoot.current) return;
    const observer = new ResizeObserver(() => {
      if (follow.current && !findOpen && !prependAnchor.current) toEnd();
    });
    observer.observe(scroll.current);
    observer.observe(transcriptRoot.current);
    return () => observer.disconnect();
  }, [session?.id, findOpen]);

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
          const items: MenuItem[] = [
            { label: '复制选中文字', disabled: !selection, run: () => copy(selection) },
            ...(block ? [{ label: '复制此代码块', run: () => copy(block.textContent ?? '') }] : []),
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
          ];
          const { clientX: x, clientY: y } = event;
          const element = target.closest<HTMLElement>('[data-link]');
          const link = element?.dataset.link ? linkTarget(element.dataset.link, place) : null;
          clearTimeout(resting.current);
          setLinkCard(null);
          if (!element || !link) {
            setContextMenu({ x, y, items });
            return;
          }
          // A link's own choices come first; what is done to the text follows.
          void linkMenu(link, (note) => showLink(element, link, note), copy).then(
            (menu) =>
              setContextMenu({
                x,
                y,
                heading: menu.heading,
                items: [...menu.items, { ...items[0], separated: true }, ...items.slice(1)],
              }),
            () => setContextMenu({ x, y, items }),
          );
        }}
        onClick={(event) => {
          // The window opens no page itself: a link is followed here, where the session's project is known.
          const anchor = (event.target as HTMLElement).closest<HTMLElement>('a[href]');
          if (!anchor || !transcriptRoot.current?.contains(anchor)) return;
          event.preventDefault();
          const link = anchor.dataset.link ? linkTarget(anchor.dataset.link, place) : null;
          clearTimeout(resting.current);
          if (link) void followLink(link, (note) => showLink(anchor, link, note));
        }}
        onPointerOver={(event) => {
          const anchor = (event.target as HTMLElement).closest<HTMLElement>('a[data-link]');
          if (!anchor || linkCard?.note) return;
          clearTimeout(resting.current);
          resting.current = setTimeout(() => {
            const link = linkTarget(anchor.dataset.link!, place);
            if (link) showLink(anchor, link);
          }, 350);
        }}
        onPointerOut={(event) => {
          const anchor = (event.target as HTMLElement).closest('a[data-link]');
          if (!anchor || anchor.contains(event.relatedTarget as Node | null)) return;
          clearTimeout(resting.current);
          setLinkCard((card) => (card?.note ? card : null));
        }}
        onScroll={() => {
          // Only when one is shown: scrolling must not draw the conversation again.
          if (linkCard) setLinkCard(null);
          if (!scroll.current) return;
          const top = scroll.current.scrollTop;
          const end = fromEnd(scroll.current) < 40;
          // Coming down to the end follows again; only moving down does, so a slow wheel or a flick upwards is not
          // pulled back while output comes in fast. Moving up away from it leaves, by touch as well: heights that
          // settle or shrink keep the view at the end, where the reader never is after scrolling up.
          if (end && top > lastTop.current) rejoin();
          else if (!end && top < lastTop.current && follow.current) leave();
          // Reading on upwards past what is loaded brings the page before it; a failed load waits for the button.
          if (top < lastTop.current && top < 240 && !loadError) loadMore();
          lastTop.current = top;
        }}
        onPointerDown={(event) => {
          // Steps opened or closed are being read where they are.
          if ((event.target as HTMLElement).closest('summary')) leave();
        }}
        onKeyDown={(event) => {
          if ((event.target as HTMLElement).closest('input, textarea, [contenteditable="true"]'))
            return;
          if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) leave();
          else if (event.key === 'End') rejoin();
        }}
        onWheel={(event) => {
          // Left at once, before the scroll it starts arrives: output in between would pull the view back.
          if (
            event.deltaY < 0 &&
            scroll.current &&
            scroll.current.scrollHeight > scroll.current.clientHeight
          )
            leave();
          // A turn down that reaches the end follows again from it. The scroll it makes is told too late for that
          // when output is coming in: by then the end has moved on.
          if (event.deltaY > 0 && scroll.current && !follow.current) {
            const box = scroll.current;
            const by =
              event.deltaMode === 1
                ? event.deltaY * 40
                : event.deltaMode === 2
                  ? event.deltaY * box.clientHeight
                  : event.deltaY;
            if (fromEnd(box) <= by + 40) rejoin();
          }
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
            <LinkPlace.Provider value={place}>
              {turns.map((turn, index) => (
                <TurnView
                  key={turn.id}
                  turn={turn}
                  native={native}
                  live={live}
                  latest={index === turns.length - 1}
                  held={heldOpen(turns, index)}
                />
              ))}
            </LinkPlace.Provider>
            {session.activeRun && background && (
              <div className="background-tasks">
                <div className="run-indicator" role="status">
                  <span className={`running-dot${connected ? ' breathing' : ''}`} />
                  后台任务{tasks.length ? ` ${tasks.length} 个` : ''} · Claude
                  已答完，任务结束后会接着处理
                  {!ownsRun && ' · 所在设备不在线'}
                </div>
                {/* The run is still on, so the controls that need it over are greyed out; this says why. */}
                <p className="background-hint">
                  任务结束前不能更改模型、思考强度和审批模式，也不能改名、分叉或编辑重发
                  {ownsRun && '；消息可以照常发送'}。
                </p>
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
            {/* A terminal holds the session: what it does is recorded here as each of its turns ends. */}
            {session.activeRun?.surface === 'terminal' && (
              <div className="run-indicator" role="status">
                <span
                  className={`running-dot${session.activeRun.activity === 'working' && connected ? ' breathing' : ''}`}
                />
                {`${terminalState(session.activeRun.activity)} · 进展随后显示在这里，关闭终端后可以在这里接着聊`}
              </div>
            )}
            {session.activeRun &&
              session.activeRun.surface !== 'terminal' &&
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
                  suffix={ownsRun ? '' : ' · 所在设备不在线'}
                />
              ) : (
                <div className="run-indicator" role="status">
                  <span className="running-dot" />
                  {session.activeRun.waiting === 'question' ? '等待回答' : '等待审批'}
                  {!ownsRun && ' · 所在设备不在线'}
                </div>
              ))}
          </div>
        )}
        {session && away && (
          <div className="to-end">
            <IconButton
              title="回到底部"
              className="to-end-button"
              onClick={() => {
                rejoin();
                toEnd();
              }}
            >
              <ArrowDown />
            </IconButton>
          </div>
        )}
      </div>
      {contextMenu && (
        <Menu label="对话文字操作" {...contextMenu} onClose={() => setContextMenu(null)} />
      )}
      {linkCard && !contextMenu && <LinkCardView card={linkCard} />}
    </SearchExpanded.Provider>
  );
}
