import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { shownWhen, slotMove, slotState } from '@cc-desk-tunnel/protocol';
import type { Plugin, ComposerSlot, Session, SlotGesture } from '@cc-desk-tunnel/protocol';

export type ShownSlot = { id: string; slot: ComposerSlot; state: string };
// The plugins' buttons a session has, each in its state there.
export const composerSlots = (plugins: Plugin[], session: Session): ShownSlot[] =>
  plugins.flatMap(({ id, composerSlot: slot, values, problem }) =>
    slot && !problem && shownWhen(slot.showWhen, values)
      ? [{ id, slot, state: slotState(slot, session.composerSlots?.[id], values) }]
      : [],
  );
// Drawn as a mask, so that the icon takes the colour of the text and nothing in it runs.
const iconStyle = (svg: string) =>
  ({ '--icon': `url("data:image/svg+xml,${encodeURIComponent(svg)}")` }) as CSSProperties;

export function ComposerSlotMarks({ plugins, session }: { plugins: Plugin[]; session: Session }) {
  return composerSlots(plugins, session).map(({ id, slot, state }) => {
    const { active, title, icon: svg } = slot.states[state]!;
    return slot.mark && active ? (
      <i
        key={id}
        className="slot-icon slot-mark"
        role="img"
        aria-label={`${slot.title}：${title}`}
        style={iconStyle(svg)}
      />
    ) : null;
  });
}

// A second click within this long of the first is a double click: the first has counted already.
const DOUBLE_MS = 400;
// A press shows as a long one only once held past a click. Let go after that and before it counts, it was thought
// better of.
const HELD_MS = 200;
const TIP_MS = 2500;

export default function ComposerSlotButton({
  shown: { slot, state: told },
  disabled,
  move,
}: {
  shown: ShownSlot;
  disabled: boolean;
  move: (gesture: SlotGesture, from: string) => void;
}) {
  // What it was just moved to, until the session says so: the next click goes by it. Should the service refuse it, or
  // another window move it meanwhile, the session is shown again a little later.
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => {
    if (chosen === null) return;
    if (chosen === told) return setChosen(null);
    const timer = setTimeout(() => setChosen(null), 3000);
    return () => clearTimeout(timer);
  }, [chosen, told]);
  const state = chosen !== null && slot.states[chosen] ? chosen : told;
  const drawn = slot.states[state]!;
  const button = useRef<HTMLButtonElement>(null);
  const [moves, setMoves] = useState(0);
  const [holding, setHolding] = useState(false);
  const [tip, setTip] = useState<{ text: string; left: number; top: number; at: number } | null>(
    null,
  );
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const clickedAt = useRef(0);
  // A press that was held is no click, whether it counted or not.
  const held = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!tip) return;
    const gone = setTimeout(() => setTip(null), TIP_MS);
    return () => clearTimeout(gone);
  }, [tip]);

  function go(gesture: SlotGesture) {
    const to = slotMove(slot, gesture, state);
    if (!to) return false;
    const text = slot.states[to]!.tip;
    const box = (button.current!.closest('.composer') ?? button.current!).getBoundingClientRect();
    setTip(text ? { text, left: box.left + box.width / 2, top: box.top, at: Date.now() } : null);
    setMoves((count) => count + 1);
    setChosen(to);
    move(gesture, state);
    return true;
  }
  function press() {
    held.current = false;
    if (!slotMove(slot, 'longPress', state)) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      held.current = true;
      setHolding(true);
      timer.current = setTimeout(() => {
        setHolding(false);
        go('longPress');
      }, slot.hold.ms - HELD_MS);
    }, HELD_MS);
  }
  function release() {
    clearTimeout(timer.current);
    setHolding(false);
  }
  function click() {
    if (held.current) {
      held.current = false;
      return;
    }
    const now = Date.now();
    const double = now - clickedAt.current < DOUBLE_MS && go('doubleClick');
    clickedAt.current = double ? 0 : now;
    if (!double) go('click');
  }
  const effect = holding ? slot.hold.effect : moves ? drawn.effect : undefined;
  return (
    <div className="slot-control">
      <button
        type="button"
        ref={button}
        className={drawn.active ? 'chip slot active' : 'chip slot'}
        aria-label={slot.title}
        title={`${slot.title}：${drawn.title}`}
        disabled={disabled}
        onPointerDown={(event) => event.button === 0 && press()}
        onPointerUp={release}
        onPointerLeave={release}
        onPointerCancel={release}
        onContextMenu={(event) => event.preventDefault()}
        onClick={click}
      >
        {/* Anew at each move, so that its effect is played again. */}
        <i
          key={moves}
          className={`slot-icon ${drawn.pivot ?? 'center'} ${effect ?? ''}`}
          style={iconStyle(drawn.icon)}
        />
        {holding && slot.hold.ring && (
          <svg
            className="slot-ring"
            viewBox="0 0 36 36"
            aria-hidden="true"
            style={{ '--press': `${slot.hold.ms - HELD_MS}ms` } as CSSProperties}
          >
            <circle cx="18" cy="18" r="16.5" pathLength="1" />
          </svg>
        )}
      </button>
      {tip &&
        createPortal(
          <p
            className="slot-tip"
            role="status"
            key={tip.at}
            style={{ left: tip.left, top: tip.top }}
          >
            {tip.text}
          </p>,
          document.body,
        )}
    </div>
  );
}
