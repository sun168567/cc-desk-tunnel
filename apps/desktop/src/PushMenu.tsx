import { useEffect, useRef, useState } from 'react';
import { Bell, BellDot, BellRing, Check } from 'lucide-react';
import type { PushMode } from '@cc-desk-tunnel/protocol';

// The session's subscription to the service's pushes, beside its approval mode: both go with the session, from
// whichever window. Shown only once the service has a channel to push to. Its menu is the approval mode's, but not its
// control: a narrow toolbar folds that one to its first icon, and the bell has nothing but its icon.
export const pushModes: { value: PushMode; name: string; detail: string; icon: typeof Bell }[] = [
  { value: 'off', name: '不订阅', detail: '不推送这个会话', icon: Bell },
  {
    value: 'once',
    name: '本轮',
    detail: '这一轮的审批、提问和结束都推送，结束后自动取消',
    icon: BellDot,
  },
  { value: 'always', name: '持续', detail: '推送这个会话之后每一轮的通知', icon: BellRing },
];

export default function PushMenu({
  mode,
  change,
}: {
  mode: PushMode;
  change: (mode: PushMode) => void;
}) {
  const [open, setOpen] = useState(false);
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
  }, [open]);
  const current = pushModes.find((item) => item.value === mode)!;
  return (
    <div className="push-control" ref={container}>
      <button
        type="button"
        className={mode === 'off' ? 'chip' : 'chip subscribed'}
        aria-label="外部推送"
        title={`外部推送：${current.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <current.icon />
      </button>
      {open && (
        <div className="permission-menu" role="menu" aria-label="外部推送">
          <p className="menu-heading">把这个会话的通知推送到外部渠道？</p>
          {pushModes.map(({ value, name, detail, icon: Icon }) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={value === mode}
              aria-label={name}
              key={value}
              onClick={() => {
                setOpen(false);
                if (value !== mode) change(value);
              }}
            >
              <Icon />
              <span className="menu-label">
                {name}
                <small>{detail}</small>
              </span>
              {value === mode && <Check className="menu-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
