import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  FilePen,
  Hand,
  ListChecks,
  ShieldCheck,
  ShieldOff,
} from 'lucide-react';
import type { PermissionMode } from '@cc-desk-tunnel/protocol';
import { usePrefs } from './prefs.ts';
import { useT } from './i18n.ts';
import { modeDetail, modeName } from './modes.ts';
import HelpLink from './HelpLink.tsx';

// The modes are Claude Code's own; the lines under them say what each asks the user for (modeDetail).
type Mode = { value: PermissionMode; icon: typeof Hand };
export const modes: Mode[] = [
  { value: 'auto', icon: ShieldCheck },
  { value: 'default', icon: Hand },
  { value: 'acceptEdits', icon: FilePen },
  { value: 'plan', icon: ListChecks },
];
// Offered once the user allowed it in the settings, and chosen only after being told what it means.
const bypass: Mode = { value: 'bypassPermissions', icon: ShieldOff };

export default function PermissionMenu({
  mode,
  disabled,
  change,
}: {
  mode: PermissionMode;
  disabled: boolean;
  change: (mode: PermissionMode) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const allowed = usePrefs().bypassPermissions;
  // A session already in that mode shows it, whatever the setting says now.
  const offered = allowed || mode === bypass.value ? [...modes, bypass] : modes;
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
      setConfirming(false);
    };
  }, [open]);
  const current = offered.find((item) => item.value === mode)!;
  return (
    <div className="permission-control" ref={container}>
      <button
        type="button"
        className={
          mode === bypass.value ? 'chip danger' : mode === 'plan' ? 'chip planning' : 'chip'
        }
        aria-label={t('session:mode.label')}
        title={modeName(t, current.value)}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <current.icon />
        <span>{modeName(t, current.value)}</span>
        <ChevronDown />
      </button>
      {open && confirming && (
        <div
          className="permission-menu"
          role="alertdialog"
          aria-label={t('session:mode.bypass.label')}
        >
          <p className="menu-heading">{t('session:mode.bypass.question')}</p>
          <p className="permission-confirm">{t('session:mode.bypass.warning')}</p>
          <div className="permission-confirm-actions">
            <button type="button" onClick={() => setConfirming(false)}>
              {t('common:cancel')}
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                setOpen(false);
                change(bypass.value);
              }}
            >
              {modeName(t, bypass.value)}
            </button>
          </div>
        </div>
      )}
      {open && !confirming && (
        <div className="permission-menu" role="menu" aria-label={t('session:mode.label')}>
          <p className="menu-heading">
            {t('session:mode.question')}
            <HelpLink article="approval" title={t('session:mode.help')} />
          </p>
          {offered.map(({ value, icon: Icon }) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={value === mode}
              aria-label={modeName(t, value)}
              className={value === bypass.value ? 'danger' : undefined}
              key={value}
              onClick={() => {
                if (value === bypass.value && value !== mode) return setConfirming(true);
                setOpen(false);
                if (value !== mode) change(value);
              }}
            >
              <Icon />
              <span className="menu-label">
                {modeName(t, value)}
                <small>{modeDetail(t, value)}</small>
              </span>
              {value === mode && <Check className="menu-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
