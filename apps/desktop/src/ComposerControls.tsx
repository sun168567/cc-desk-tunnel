import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, Check, RotateCcw } from 'lucide-react';
import { usePrefs } from './prefs.ts';
import { quotaFigures } from './quota.ts';
import type {
  Effort,
  NativeCapabilities,
  NativeMetrics,
  NativeSession,
} from '@cc-desk-tunnel/protocol';
import { IconButton } from './ui.tsx';

const effortNames: Record<Effort, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
};
export default function ComposerControls({
  model,
  effort,
  capabilities,
  nativeSession,
  metrics,
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
  openAccount: () => void;
  disabled: boolean;
  configure: (values: { model?: string | null; effort?: Effort | null }) => Promise<void>;
  refresh: () => void;
  refreshing: boolean;
  canRefreshModels: boolean;
}) {
  const [open, setOpen] = useState(false),
    [contextOpen, setContextOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) {
        setOpen(false);
        setContextOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setContextOpen(false);
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
  const label = chosen?.displayName ?? model ?? '原生默认';
  const context = metrics?.context;
  // How full the window is, drawn as a ring that changes colour as it runs out.
  const contextUsed = context ? Math.min(100, Math.max(0, context.percentage)) : 0;
  const contextLevel = !context
    ? 'unknown'
    : contextUsed >= 90
      ? 'full'
      : contextUsed >= 70
        ? 'high'
        : 'ok';
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
  const quota = usePrefs().quota ? quotaFigures(metrics?.rateLimits) : [];
  const fullest = Math.max(0, ...quota.map((figure) => figure.used));
  return (
    <div className="composer-controls" ref={container}>
      {quota.length > 0 && (
        <button
          type="button"
          className={`quota-note ${fullest >= 90 ? 'danger' : fullest >= 70 ? 'warn' : ''}`}
          aria-label="额度已用"
          title={[
            ...quota.map(
              (figure) =>
                `${figure.label}额度已用 ${figure.used}%${
                  figure.resetsAt
                    ? `，${new Date(figure.resetsAt).toLocaleString('zh-CN')} 重置`
                    : ''
                }`,
            ),
            '点击查看账号与额度',
          ].join('\n')}
          onClick={openAccount}
        >
          {quota.map((figure) => `${figure.label} ${figure.used}%`).join(' · ')}
        </button>
      )}
      <div
        className="context-control"
        onMouseEnter={() => setContextOpen(true)}
        onMouseLeave={() => setContextOpen(false)}
      >
        <button
          type="button"
          className="icon-button context-button"
          aria-label="上下文窗口"
          aria-expanded={contextOpen}
          title={context ? `上下文 ${context.percentage}%` : '上下文窗口'}
          onFocus={() => setContextOpen(true)}
          onBlur={() => setContextOpen(false)}
          onClick={() => setContextOpen(true)}
        >
          <svg className={`context-ring ${contextLevel}`} viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="7.5" pathLength={100} />
            <circle
              className="context-ring-used"
              cx="10"
              cy="10"
              r="7.5"
              pathLength={100}
              strokeDasharray={`${contextUsed} 100`}
            />
          </svg>
        </button>
        {contextOpen && (
          <div className="context-tooltip" role="tooltip">
            <strong>上下文窗口</strong>
            {context ? (
              <>
                <span>
                  {context.percentage}% 已用（剩余 {Math.max(0, 100 - context.percentage)}%）
                </span>
                <span>
                  {context.usedTokens.toLocaleString()} / {context.windowTokens.toLocaleString()}{' '}
                  tokens
                </span>
                <small>{new Date(context.measuredAt).toLocaleTimeString('zh-CN')} · 原生摘要</small>
              </>
            ) : (
              <span>{metrics?.errors?.context ?? '等待原生状态'}</span>
            )}
          </div>
        )}
      </div>
      <div className="model-control">
        <button
          type="button"
          className="model-trigger"
          disabled={disabled}
          aria-label="模型与推理强度"
          aria-expanded={open}
          onClick={() => {
            setOpen((value) => !value);
            setChoosing(false);
          }}
        >
          <span>{label}</span>
          <small>{effort ? effortNames[effort] : actual ? effortNames[actual] : '默认'}</small>
          <ChevronDown />
        </button>
        {open && (
          <div className="model-menu" role="dialog" aria-label="模型与推理强度">
            <div className="effort-view" hidden={choosing}>
              <div className="effort-heading">
                <strong>{shownEffort ? effortNames[shownEffort] : '原生默认'}</strong>
                <IconButton
                  title="恢复默认推理强度"
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
                        ? `${(Math.max(0, levels.indexOf(shownEffort)) / Math.max(1, levels.length - 1)) * 100}%`
                        : '0%',
                    } as CSSProperties
                  }
                  aria-label="推理强度"
                  disabled={disabled}
                  type="range"
                  min={0}
                  max={levels.length - 1}
                  aria-valuetext={shownEffort ? effortNames[shownEffort] : '原生默认'}
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
                      {effortNames[level]}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {choosing && (
              <>
                <button type="button" className="model-back" onClick={() => setChoosing(false)}>
                  <ArrowLeft />
                  选择模型
                </button>
                <div className="model-options" role="listbox" aria-label="模型">
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
                    <span>默认模型</span>
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
                        onClick={() => {
                          void configure({ model: row.value, effort: null });
                          setOpen(false);
                        }}
                      >
                        <span>
                          {row.displayName}
                          {row.resolvedModel && <small>{row.resolvedModel}</small>}
                          <small>{row.description}</small>
                        </span>
                        {model !== null && chosen?.value === row.value && <Check />}
                      </button>
                    ))}
                </div>
                <button
                  type="button"
                  className="model-back"
                  disabled={disabled || refreshing || !canRefreshModels}
                  title={canRefreshModels ? undefined : '有会话正在运行，结束后可刷新'}
                  onClick={refresh}
                >
                  <RotateCcw />
                  {refreshing ? '正在刷新模型列表…' : '刷新模型列表'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
