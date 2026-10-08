import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  const shown = open || forced;
  return (
    <details
      className={className}
      open={shown}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
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
          <pre className="tool-input">{tool.input}</pre>
          {tool.liveOutput && !tool.output && <pre className="tool-output">{tool.liveOutput}</pre>}
          {tool.output && (
            <pre className="tool-output">
              {tool.exitCode !== null && tool.exitCode !== undefined && `退出码 ${tool.exitCode}\n`}
              {tool.output}
            </pre>
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
                <div className="message-content tool-detail">
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
      </div>
      <div className="message-content">
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
  edit,
}: {
  session: Session | undefined;
  events: SessionEvent[];
  history: HistoryState | undefined;
  connected: boolean;
  native: boolean;
  ownsRun: boolean;
  busy: boolean;
  newSession: () => void;
  loadEarlier: () => void;
  replyApproval: (
    runId: string,
    approvalId: string,
    allowed: boolean,
    answers?: Record<string, string>,
  ) => void;
  edit?: (messageId: string, text: string) => void;
}) {
  const turns = useMemo(() => conversation(events), [events]);
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
    if (follow.current) scroll.current?.scrollTo(0, scroll.current.scrollHeight);
  }, [events, history?.loadingEarlier, session?.id]);

  return (
    <div
      className="conversation"
      ref={scroll}
      onScroll={() => {
        if (scroll.current)
          follow.current =
            scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight <
            80;
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
        <div className="transcript">
          {history?.hasEarlier && (
            <button
              type="button"
              className="history-load"
              disabled={!connected || history.loadingEarlier || history.loading}
              onClick={() => {
                if (scroll.current)
                  prependAnchor.current = {
                    sessionId: session.id,
                    height: scroll.current.scrollHeight,
                    top: scroll.current.scrollTop,
                  };
                loadEarlier();
              }}
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
          {session.activeRun && (
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
  );
}
