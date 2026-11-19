import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Bell, BellDot, BellRing } from 'lucide-react';
import type { PushMode } from '@cc-desk-tunnel/protocol';

// The session's subscription to the service's pushes, beside its approval mode: both go with the session, from
// whichever window. Shown only once the service has a channel to push to. No menu: a click subscribes to this round,
// a second click right after it (a double click or tap) or a long press subscribes for good, as does a long press
// while subscribed to the round, and a click on a subscribed bell cancels. Its own control, not the approval mode's:
// a narrow toolbar folds that one to its first icon, and the bell has nothing but its icon.
const icons = { off: Bell, once: BellDot, always: BellRing };
const names = { off: '不订阅', once: '本轮', always: '持续' };
const hints = {
  off: '点击订阅本轮，双击或长按持续订阅',
  once: '点击取消订阅，长按持续订阅',
  always: '点击取消订阅',
};
// How long a tip stays, and how long it takes to fade out at the end of that.
const tipShown = 2500;
const tipFade = 140;
const tips = {
  off: '已取消订阅',
  once: '已订阅本轮，这一轮结束后自动取消',
  always: '已持续订阅',
};
// A second click within this long of subscribing to the round makes it lasting rather than cancelling it.
const doubleClick = 400;
// A press shows the ring only once held past a click, then the ring fills; full, the subscription is lasting.
const ringAfter = 200;
const ringFill = 600;

export default function PushMenu({
  mode: session,
  change,
}: {
  mode: PushMode;
  change: (mode: PushMode) => void;
}) {
  // What was last clicked, until the session catches up: a click straight after another goes by it. Should the
  // service refuse, or another window change it meanwhile, the session is shown again a little later.
  const [chosen, setChosen] = useState<PushMode | null>(null);
  useEffect(() => {
    if (chosen === null) return;
    if (chosen === session) return setChosen(null);
    const timer = setTimeout(() => setChosen(null), 3000);
    return () => clearTimeout(timer);
  }, [chosen, session]);
  const mode = chosen ?? session;
  // Shown just above the input box, measured when it is shown: the bell's own toolbar would put it over what is typed.
  const [tip, setTip] = useState<{ text: string; left: number; top: number; at: number } | null>(
    null,
  );
  const [leaving, setLeaving] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const [pressing, setPressing] = useState(false);
  // Counts subscriptions so that each one shakes the bell anew; cancelling does not.
  const [shakes, setShakes] = useState(0);
  const subscribedAt = useRef(0);
  const pressTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The click that ends a long press must not also count as a click.
  const pressed = useRef(false);
  useEffect(() => {
    if (!tip) return;
    setLeaving(false);
    const fade = setTimeout(() => setLeaving(true), tipShown - tipFade);
    const gone = setTimeout(() => setTip(null), tipShown);
    return () => {
      clearTimeout(fade);
      clearTimeout(gone);
    };
  }, [tip]);
  useEffect(() => () => clearTimeout(pressTimer.current), []);
  function choose(next: PushMode) {
    const box = (button.current!.closest('.composer') ?? button.current!).getBoundingClientRect();
    setTip({ text: tips[next], left: box.left + box.width / 2, top: box.top, at: Date.now() });
    if (next !== 'off') setShakes((count) => count + 1);
    if (next === mode) return;
    setChosen(next);
    change(next);
  }
  function release() {
    clearTimeout(pressTimer.current);
    setPressing(false);
  }
  const Icon = icons[mode];
  return (
    <div className="push-control">
      <button
        type="button"
        ref={button}
        className={mode === 'off' ? 'chip' : 'chip subscribed'}
        aria-label="外部推送"
        title={`外部推送：${names[mode]}（${hints[mode]}）`}
        onPointerDown={(event) => {
          // Cleared here, not by the click it skips: a long press on a phone is often followed by no click at all.
          pressed.current = false;
          // A lasting subscription has nothing to be held to, so a press there does not fill the ring.
          if (event.button !== 0 || mode === 'always') return;
          clearTimeout(pressTimer.current);
          pressTimer.current = setTimeout(() => {
            setPressing(true);
            pressTimer.current = setTimeout(() => {
              pressed.current = true;
              setPressing(false);
              choose('always');
            }, ringFill);
          }, ringAfter);
        }}
        onPointerUp={release}
        onPointerLeave={release}
        onPointerCancel={release}
        onContextMenu={(event) => event.preventDefault()}
        onClick={() => {
          if (pressed.current) {
            pressed.current = false;
            return;
          }
          if (Date.now() - subscribedAt.current < doubleClick) {
            subscribedAt.current = 0;
            choose('always');
          } else if (mode === 'off') {
            subscribedAt.current = Date.now();
            choose('once');
          } else {
            subscribedAt.current = 0;
            choose('off');
          }
        }}
      >
        {/* The shake is on a wrapper, not the icon, which is replaced once the service answers. */}
        <span className={shakes ? 'push-bell shake' : 'push-bell'} key={shakes}>
          <Icon />
        </span>
        {pressing && (
          <svg
            className="push-ring"
            viewBox="0 0 36 36"
            aria-hidden="true"
            style={{ '--press': `${ringFill}ms` } as CSSProperties}
          >
            <circle cx="18" cy="18" r="16.5" pathLength="1" />
          </svg>
        )}
      </button>
      {tip &&
        createPortal(
          <p
            className={leaving ? 'push-tip leaving' : 'push-tip'}
            role="status"
            // A new tip comes in afresh rather than taking the place of the one showing.
            key={tip.at}
            style={{ left: tip.left, top: tip.top, '--fade': `${tipFade}ms` } as CSSProperties}
          >
            {tip.text}
          </p>,
          document.body,
        )}
    </div>
  );
}
