import { lazy, Suspense, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, ListChecks, Maximize2, Pencil, Undo2 } from 'lucide-react';
import { PLAN_LIMIT } from '@cc-desk-tunnel/protocol';
import type { PlanMode } from '@cc-desk-tunnel/protocol';
import { CopyButton } from './copy.tsx';
import { IconButton, Modal } from './ui.tsx';
import { modeNames } from './modes.ts';

const RichText = lazy(() => import('./RichText.tsx'));
const Rich = ({ text }: { text: string }) => (
  <Suspense fallback={<p className="plan-loading">{text}</p>}>
    <RichText text={text} />
  </Suspense>
);

// What the user said in sending a plan back, as the service passed it on to Claude.
const FEEDBACK = 'Their feedback:\n';
export function feedbackOf(output?: string) {
  const at = output?.indexOf(FEEDBACK) ?? -1;
  return at < 0 ? '' : output!.slice(at + FEEDBACK.length).trim();
}

// The modes a plan approved may be carried out in, as Claude Code's own plan approval offers them.
const choices: { mode: PlanMode; detail: string }[] = [
  { mode: 'auto', detail: '由 Claude Code 判断风险，只在必要时询问' },
  { mode: 'acceptEdits', detail: '文件编辑直接通过，执行命令仍先询问' },
  { mode: 'default', detail: '编辑文件和执行命令前都先询问' },
];

export type PlanOutcome =
  // Not decided yet, and not here: in another window, or by whoever runs the session.
  | { kind: 'waiting' }
  | { kind: 'approved'; mode?: PlanMode; edited?: boolean }
  | { kind: 'returned'; feedback: string }
  // The run ended before it was decided.
  | { kind: 'open' };
export type PlanDecide = {
  busy: boolean;
  // The mode offered first: the one the session was in before it went into plan mode.
  mode: PlanMode;
  approve: (mode: PlanMode, edited?: string) => void;
  keepPlanning: (feedback: string) => void;
};

const outcomeText = (outcome: PlanOutcome) =>
  outcome.kind === 'approved'
    ? [
        '已批准',
        ...(outcome.mode ? [modeNames[outcome.mode]] : []),
        ...(outcome.edited ? ['已修改'] : []),
      ].join(' · ')
    : outcome.kind === 'returned'
      ? '已退回，继续规划'
      : outcome.kind === 'open'
        ? '未处理'
        : '等待批准';

// Claude's plan, read as a document: shown in part with the rest a click away, read whole in a window of its own,
// copied as written. Until it is decided here it is carried out in a mode chosen, as written or as changed here, or
// sent back to be planned further with what to change; afterwards it says how it was decided.
export default function PlanCard({
  plan,
  file,
  outcome,
  decide,
  folded = false,
}: {
  plan: string;
  file?: string;
  outcome?: PlanOutcome;
  decide?: PlanDecide;
  // Shown by its heading alone, as in a turn that is over.
  folded?: boolean;
}) {
  const [open, setOpen] = useState(!folded);
  const [whole, setWhole] = useState(false);
  const [long, setLong] = useState(false);
  const [reading, setReading] = useState(false);
  // The mode chosen here; until then the one offered, which the session may report only after the card is shown.
  const [chosen, setMode] = useState<PlanMode | null>(null);
  const mode = chosen ?? decide?.mode ?? 'auto';
  const [editing, setEditing] = useState<string | null>(null);
  const [returning, setReturning] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  // Long enough to be cut short: measured again as its text is laid out, which the Markdown, loaded late, changes.
  useLayoutEffect(() => {
    const element = body.current;
    if (!element || whole) return;
    const measure = () => setLong(element.scrollHeight > element.clientHeight + 4);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [plan, open, editing, whole]);
  const name = file?.split(/[\\/]/).at(-1);
  const busy = !!decide?.busy;
  return (
    <section
      className={`plan-card${outcome?.kind === 'returned' ? ' returned' : ''}`}
      aria-label="Claude 的计划"
    >
      <header className="plan-heading">
        {decide ? (
          <span className="plan-title">
            <ListChecks />
            <span>计划</span>
            {name && <small title={file}>{name}</small>}
          </span>
        ) : (
          <button
            type="button"
            className="plan-title"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <ListChecks />
            <span>计划</span>
            {name && <small title={file}>{name}</small>}
          </button>
        )}
        {outcome && <span className={`plan-outcome ${outcome.kind}`}>{outcomeText(outcome)}</span>}
        <span className="plan-tools">
          <CopyButton text={editing ?? plan} label="复制计划" />
          <IconButton title="全屏阅读" onClick={() => setReading(true)}>
            <Maximize2 />
          </IconButton>
        </span>
      </header>
      {open &&
        (editing !== null ? (
          <textarea
            className="plan-editor"
            aria-label="修改计划"
            value={editing}
            maxLength={PLAN_LIMIT}
            disabled={busy}
            onChange={(event) => setEditing(event.target.value)}
          />
        ) : (
          <>
            <div
              ref={body}
              className={`plan-body message-content${whole ? ' whole' : long ? ' clipped' : ''}`}
              data-search-content
            >
              <Rich text={plan} />
            </div>
            {(long || whole) && (
              <button
                type="button"
                className="plan-more"
                onClick={() => setWhole((value) => !value)}
              >
                {whole ? <ChevronUp /> : <ChevronDown />}
                {whole ? '收起' : '展开全文'}
              </button>
            )}
          </>
        ))}
      {open && outcome?.kind === 'returned' && outcome.feedback && (
        <p className="plan-feedback">你的意见：{outcome.feedback}</p>
      )}
      {decide && returning !== null && (
        <form
          className="plan-return"
          onSubmit={(event) => {
            event.preventDefault();
            decide.keepPlanning(returning.trim());
          }}
        >
          <textarea
            aria-label="哪里要改"
            placeholder="说说哪里要改，Claude 会按你的意见接着规划（可以不填）"
            value={returning}
            maxLength={PLAN_LIMIT}
            disabled={busy}
            autoFocus
            onChange={(event) => setReturning(event.target.value)}
          />
          <div className="approval-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setReturning(null)}
            >
              取消
            </button>
            <button type="submit" className="button primary" disabled={busy}>
              <Undo2 />
              退回，继续规划
            </button>
          </div>
        </form>
      )}
      {decide && returning === null && (
        <div className="plan-decide">
          <div className="plan-modes" role="radiogroup" aria-label="执行时的审批模式">
            <span className="plan-modes-label">执行时</span>
            {choices.map((choice) => (
              <button
                type="button"
                role="radio"
                key={choice.mode}
                aria-checked={mode === choice.mode}
                title={choice.detail}
                className="stat-chip"
                disabled={busy}
                onClick={() => setMode(choice.mode)}
              >
                {modeNames[choice.mode]}
              </button>
            ))}
          </div>
          <div className="approval-actions">
            {editing === null ? (
              <>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setReturning('')}
                >
                  <Undo2 />
                  继续规划
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => {
                    setOpen(true);
                    setEditing(plan);
                  }}
                >
                  <Pencil />
                  修改计划
                </button>
                <button
                  type="button"
                  className="button primary"
                  disabled={busy}
                  onClick={() => decide.approve(mode)}
                >
                  <Check />
                  开始执行
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setEditing(null)}
                >
                  取消修改
                </button>
                <button
                  type="button"
                  className="button primary"
                  disabled={busy || !editing.trim()}
                  onClick={() =>
                    decide.approve(mode, editing.trim() === plan.trim() ? undefined : editing)
                  }
                >
                  <Check />
                  按修改后的计划执行
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {reading && (
        <Modal title={name ? `计划 · ${name}` : '计划'} onClose={() => setReading(false)}>
          <div className="plan-reader message-content">
            <Rich text={editing ?? plan} />
          </div>
        </Modal>
      )}
    </section>
  );
}
