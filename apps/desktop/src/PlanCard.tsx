import { lazy, Suspense, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, ListChecks, Maximize2, Pencil, Undo2 } from 'lucide-react';
import { PLAN_LIMIT } from '@cc-desk-tunnel/protocol';
import type { PlanMode } from '@cc-desk-tunnel/protocol';
import { type T, useT } from './i18n.ts';
import { CopyButton } from './copy.tsx';
import { IconButton, Modal } from './ui.tsx';
import { modeDetail, modeName } from './modes.ts';

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
const choices: PlanMode[] = ['auto', 'acceptEdits', 'default'];

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

const outcomeText = (t: T, outcome: PlanOutcome) =>
  outcome.kind === 'approved'
    ? [
        t('session:plan.approved'),
        ...(outcome.mode ? [modeName(t, outcome.mode)] : []),
        ...(outcome.edited ? [t('session:plan.edited')] : []),
      ].join(' · ')
    : t(`session:plan.${outcome.kind}`);

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
  const t = useT();
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
      aria-label={t('session:plan.label')}
    >
      <header className="plan-heading">
        {decide ? (
          <span className="plan-title">
            <ListChecks />
            <span>{t('session:plan.title')}</span>
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
            <span>{t('session:plan.title')}</span>
            {name && <small title={file}>{name}</small>}
          </button>
        )}
        {outcome && (
          <span className={`plan-outcome ${outcome.kind}`}>{outcomeText(t, outcome)}</span>
        )}
        <span className="plan-tools">
          <CopyButton text={editing ?? plan} label={t('session:plan.copy')} />
          <IconButton title={t('session:plan.read')} onClick={() => setReading(true)}>
            <Maximize2 />
          </IconButton>
        </span>
      </header>
      {open &&
        (editing !== null ? (
          <textarea
            className="plan-editor"
            aria-label={t('session:plan.edit')}
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
                {whole ? t('common:collapse') : t('session:plan.whole')}
              </button>
            )}
          </>
        ))}
      {open && outcome?.kind === 'returned' && outcome.feedback && (
        <p className="plan-feedback">
          {t('session:plan.feedback', { feedback: outcome.feedback })}
        </p>
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
            aria-label={t('session:plan.feedbackLabel')}
            placeholder={t('session:plan.feedbackHint')}
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
              {t('common:cancel')}
            </button>
            <button type="submit" className="button primary" disabled={busy}>
              <Undo2 />
              {t('session:plan.sendBack')}
            </button>
          </div>
        </form>
      )}
      {decide && returning === null && (
        <div className="plan-decide">
          <div className="plan-modes" role="radiogroup" aria-label={t('session:plan.modeLabel')}>
            <span className="plan-modes-label">{t('session:plan.modes')}</span>
            {choices.map((choice) => (
              <button
                type="button"
                role="radio"
                key={choice}
                aria-checked={mode === choice}
                title={modeDetail(t, choice)}
                className="stat-chip"
                disabled={busy}
                onClick={() => setMode(choice)}
              >
                {modeName(t, choice)}
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
                  {t('session:plan.keepPlanning')}
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
                  {t('session:plan.edit')}
                </button>
                <button
                  type="button"
                  className="button primary"
                  disabled={busy}
                  onClick={() => decide.approve(mode)}
                >
                  <Check />
                  {t('session:plan.start')}
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
                  {t('session:plan.discard')}
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
                  {t('session:plan.startEdited')}
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {reading && (
        <Modal
          title={name ? t('session:plan.titleOf', { name }) : t('session:plan.title')}
          onClose={() => setReading(false)}
        >
          <div className="plan-reader message-content">
            <Rich text={editing ?? plan} />
          </div>
        </Modal>
      )}
    </section>
  );
}
