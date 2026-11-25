import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, Check, RotateCcw } from 'lucide-react';
import { localeOf, type T, useT } from './i18n.ts';
import { usePrefs } from './prefs.ts';
import { quotaFigures } from './quota.ts';
import type {
  AccountQuota,
  Effort,
  NativeCapabilities,
  NativeMetrics,
  NativeSession,
} from '@cc-desk-tunnel/protocol';
import ContextMeter from './ContextMeter.tsx';
import { IconButton } from './ui.tsx';
import { modelDetail, modelName } from './modelNames.ts';

const effortName = (t: T, effort: Effort) => t(`session:effort.${effort}`);
export default function ComposerControls({
  model,
  effort,
  capabilities,
  nativeSession,
  metrics,
  quota: account,
  openAccount,
  disabled,
  configure,
  refresh,
  refreshing,
  canRefreshModels,
}: {
  model: string | null;
  effort: Effort | null;
  capabilities: NativeCapabilities | null;
  nativeSession: NativeSession | null;
  metrics: NativeMetrics | null;
  // The account's quota, shown beside the session's context.
  quota: AccountQuota | null;
  openAccount: () => void;
  disabled: boolean;
  configure: (values: { model?: string | null; effort?: Effort | null }) => Promise<void>;
  refresh: () => void;
  refreshing: boolean;
  canRefreshModels: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // With the strip under the input box switched on, the ring is shown there instead.
  const barShowsContext = usePrefs().sessionBar.enabled;
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  // The menu opens on the effort slider; the list of models is one step further in.
  const [choosing, setChoosing] = useState(false);
  const [preview, setPreview] = useState<Effort | null>(null);
  const dragging = useRef(false);
  const commitPending = useRef(false);
  const chosen =
    capabilities?.models.find((row) => row.value === (model ?? 'default')) ??
    capabilities?.models.find((row) => row.resolvedModel === (model ?? nativeSession?.model));
  const levels = chosen?.supportedEffortLevels ?? [];
  const actual = nativeSession?.effort;
  const shownEffort = preview ?? effort ?? actual;
  const label = chosen ? modelName(chosen) : (model ?? t('session:effort.native'));
  async function saveEffort() {
    dragging.current = false;
    if (!commitPending.current || disabled) return;
    commitPending.current = false;
    const value = preview;
    try {
      await configure({ effort: value });
    } finally {
      setPreview(null);
    }
  }
  useEffect(() => {
    setPreview(null);
    commitPending.current = false;
    dragging.current = false;
  }, [model]);
  const quota = usePrefs().quota ? quotaFigures(t, account?.rateLimits) : [];
  const fullest = Math.max(0, ...quota.map((figure) => figure.used));
  return (
    <div className="composer-controls" ref={container}>
      {quota.length > 0 && (
        <button
          type="button"
          className={`quota-note ${fullest >= 90 ? 'danger' : fullest >= 70 ? 'warn' : ''}`}
          aria-label={t('session:quota.label')}
          title={[
            ...quota.map((figure) =>
              figure.resetsAt
                ? t('session:quota.usedResets', {
                    label: figure.label,
                    used: figure.used,
                    time: new Date(figure.resetsAt).toLocaleString(localeOf(t)),
                  })
                : t('session:quota.used', { label: figure.label, used: figure.used }),
            ),
            t('session:quota.open'),
          ].join('\n')}
          onClick={openAccount}
        >
          {quota.map((figure) => `${figure.label} ${figure.used}%`).join(' · ')}
        </button>
      )}
      {!barShowsContext && <ContextMeter metrics={metrics} />}
      <div className="model-control">
        <button
          type="button"
          className="model-trigger"
          disabled={disabled}
          aria-label={t('session:model.label')}
          aria-expanded={open}
          onClick={() => {
            setOpen((value) => !value);
            setChoosing(false);
          }}
        >
          <span>{label}</span>
          <small>
            {effort
              ? effortName(t, effort)
              : actual
                ? effortName(t, actual)
                : t('session:effort.default')}
          </small>
          <ChevronDown />
        </button>
        {open && (
          <div
            className={`model-menu${choosing ? ' choosing' : ''}`}
            role="dialog"
            aria-label={t('session:model.label')}
          >
            <div className="effort-view" hidden={choosing}>
              <div className="effort-heading">
                <strong>
                  {shownEffort ? effortName(t, shownEffort) : t('session:effort.native')}
                </strong>
                <IconButton
                  title={t('session:effort.reset')}
                  disabled={disabled}
                  onClick={() => {
                    setPreview(null);
                    void configure({ effort: null });
                  }}
                >
                  <RotateCcw />
                </IconButton>
              </div>
              <button type="button" className="model-current" onClick={() => setChoosing(true)}>
                {label}
                <ChevronRight />
              </button>
              {levels.length > 0 && (
                <input
                  style={
                    {
                      '--fill': shownEffort
                        ? Math.max(0, levels.indexOf(shownEffort)) / Math.max(1, levels.length - 1)
                        : 0,
                    } as CSSProperties
                  }
                  aria-label={t('session:effort.label')}
                  disabled={disabled}
                  type="range"
                  min={0}
                  max={levels.length - 1}
                  aria-valuetext={
                    shownEffort ? effortName(t, shownEffort) : t('session:effort.native')
                  }
                  value={Math.max(0, levels.indexOf(shownEffort ?? 'high'))}
                  data-unset={shownEffort ? undefined : ''}
                  onPointerDown={(event) => {
                    dragging.current = true;
                    // Unset: the handle is hidden, so pressing where it would be picks that level; dragging or a press elsewhere overrides it.
                    if (!shownEffort) {
                      setPreview(levels[Number(event.currentTarget.value)]);
                      commitPending.current = true;
                    }
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onChange={(event) => {
                    setPreview(levels[Number(event.target.value)]);
                    commitPending.current = true;
                  }}
                  onPointerUp={() => {
                    void saveEffort();
                  }}
                  onPointerCancel={() => {
                    dragging.current = false;
                    commitPending.current = false;
                    setPreview(null);
                  }}
                  onKeyUp={(event) => {
                    if (
                      [
                        'ArrowLeft',
                        'ArrowRight',
                        'ArrowUp',
                        'ArrowDown',
                        'Home',
                        'End',
                        'PageUp',
                        'PageDown',
                      ].includes(event.key)
                    )
                      void saveEffort();
                  }}
                  onBlur={() => {
                    if (!dragging.current) void saveEffort();
                  }}
                />
              )}
              {levels.length > 0 && (
                <div className="effort-ticks">
                  {levels.map((level, index) => (
                    <button
                      key={level}
                      type="button"
                      tabIndex={-1}
                      disabled={disabled}
                      className={level === shownEffort ? 'current' : undefined}
                      style={
                        {
                          '--at': index / Math.max(1, levels.length - 1),
                        } as CSSProperties
                      }
                      onClick={() => void configure({ effort: level })}
                    >
                      {effortName(t, level)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {choosing && (
              <>
                <button type="button" className="model-back" onClick={() => setChoosing(false)}>
                  <ArrowLeft />
                  {t('session:model.choose')}
                </button>
                <div className="model-options" role="listbox" aria-label={t('session:model.model')}>
                  <button
                    type="button"
                    role="option"
                    disabled={disabled}
                    aria-selected={model === null}
                    onClick={() => {
                      void configure({ model: null, effort: null });
                      setOpen(false);
                    }}
                  >
                    <span>{t('session:model.default')}</span>
                    {model === null && <Check />}
                  </button>
                  {capabilities?.models
                    .filter((row) => row.value !== 'default')
                    .map((row) => (
                      <button
                        type="button"
                        role="option"
                        disabled={disabled}
                        aria-selected={model !== null && chosen?.value === row.value}
                        key={row.value}
                        title={[row.resolvedModel, modelDetail(row)].filter(Boolean).join('\n')}
                        onClick={() => {
                          void configure({ model: row.value, effort: null });
                          setOpen(false);
                        }}
                      >
                        <span>{modelName(row)}</span>
                        {model !== null && chosen?.value === row.value && <Check />}
                      </button>
                    ))}
                </div>
                <button
                  type="button"
                  className="model-refresh"
                  disabled={disabled || refreshing || !canRefreshModels}
                  title={canRefreshModels ? undefined : t('session:model.busy')}
                  onClick={refresh}
                >
                  <RotateCcw />
                  {refreshing ? t('session:model.refreshing') : t('session:model.refresh')}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
