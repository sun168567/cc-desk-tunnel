import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, Check, RotateCcw } from 'lucide-react';
import { Claude, OpenAI } from '@lobehub/icons';
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

const effortThemes: Record<Effort, { color: string; gradient: string }> = {
  low: {
    color: '#0ea5e9',
    gradient: 'linear-gradient(90deg, #93c5fd 0%, #38bdf8 100%)',
  },
  medium: {
    color: '#2563eb',
    gradient: 'linear-gradient(90deg, #7dd3fc 0%, #3b82f6 55%, #2563eb 100%)',
  },
  high: {
    color: '#4338ca',
    gradient: 'linear-gradient(90deg, #7dd3fc 0%, #2563eb 50%, #4338ca 100%)',
  },
  xhigh: {
    color: '#7c3aed',
    gradient: 'linear-gradient(90deg, #7dd3fc 0%, #2563eb 36%, #4f46e5 68%, #7c3aed 100%)',
  },
  max: {
    color: '#9333ea',
    gradient:
      'linear-gradient(90deg, #7dd3fc 0%, #2563eb 28%, #4f46e5 54%, #7c3aed 78%, #9333ea 100%)',
  },
};
export default function ComposerControls({
  provider = 'claude',
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
  openaiModels,
}: {
  provider?: 'claude' | 'openai';
  model: string | null;
  effort: Effort | null;
  capabilities: NativeCapabilities | null;
  nativeSession: NativeSession | null;
  metrics: NativeMetrics | null;
  openAccount: () => void;
  disabled: boolean;
  configure: (values: {
    model?: string | null;
    effort?: Effort | null;
    provider?: 'claude' | 'openai';
  }) => Promise<void>;
  refresh: () => void;
  refreshing: boolean;
  canRefreshModels: boolean;
  openaiModels: { id: string; displayName: string }[];
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
    provider === 'openai'
      ? undefined
      : (capabilities?.models.find((row) => row.value === (model ?? 'default')) ??
          capabilities?.models.find((row) => row.resolvedModel === (model ?? nativeSession?.model)));
  const defaultLevels: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
  const levels =
    provider === 'openai'
      ? defaultLevels
      : chosen?.supportedEffortLevels?.length
        ? chosen.supportedEffortLevels
        : defaultLevels;
  const actual = nativeSession?.effort;
  const shownEffort = preview ?? effort ?? actual;
  const label =
    provider === 'openai'
      ? (openaiModels.find((row) => row.id === model)?.displayName ?? model ?? 'Codex 默认')
      : (chosen?.displayName ?? model ?? '原生默认');
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
          {context && <span className="context-percent">{context.percentage}%</span>}
        </button>
        {contextOpen && (
          <div className="context-tooltip" role="tooltip">
            <div>
              <strong>上下文窗口</strong>
              {context && (
                <span>
                  {context.percentage}% 已用 · {Math.max(0, 100 - context.percentage)}% 剩余
                </span>
              )}
            </div>
            {context ? (
              <>
                <progress max={100} value={contextUsed} className={contextLevel} />
                <small>
                  {context.usedTokens.toLocaleString()} / {context.windowTokens.toLocaleString()}{' '}
                  tokens · {new Date(context.measuredAt).toLocaleTimeString('zh-CN')}
                </small>
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
          {provider === 'openai' ? (
            <OpenAI size={13} className="model-trigger-claude" />
          ) : (
            <Claude.Color size={13} className="model-trigger-claude" />
          )}
          <span>{label}</span>
          <small
            style={
              shownEffort
                ? ({ color: effortThemes[shownEffort].color, fontWeight: 500 } as CSSProperties)
                : undefined
            }
          >
            {effort ? effortNames[effort] : actual ? effortNames[actual] : '默认'}
          </small>
          <ChevronDown />
        </button>
        {open && (
          <div className="model-menu" role="dialog" aria-label="模型与推理强度">
            <div
              className="effort-view"
              hidden={choosing}
              style={
                shownEffort
                  ? ({
                      '--effort-color': effortThemes[shownEffort].color,
                      '--effort-gradient': effortThemes[shownEffort].gradient,
                    } as CSSProperties)
                  : undefined
              }
            >
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
                <span className="model-current-name">
                  {provider === 'openai' ? <OpenAI size={13} /> : <Claude.Color size={13} />}
                  {label}
                </span>
                <ChevronRight />
              </button>
              {levels.length > 0 && (
                <input
                  style={
                    {
                      '--ratio': shownEffort
                        ? Math.max(0, levels.indexOf(shownEffort)) / Math.max(1, levels.length - 1)
                        : 0,
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
                    aria-selected={provider !== 'openai' && model === null}
                    onClick={() => {
                      void configure({
                        model: null,
                        effort: null,
                        ...(provider === 'openai' ? { provider: 'claude' } : {}),
                      });
                      setOpen(false);
                    }}
                  >
                    <span>默认模型</span>
                    {provider !== 'openai' && model === null && <Check />}
                  </button>
                  {capabilities?.models
                    .filter((row) => row.value !== 'default')
                    .map((row) => (
                      <button
                        type="button"
                        role="option"
                        disabled={disabled}
                        aria-selected={
                          provider !== 'openai' && model !== null && chosen?.value === row.value
                        }
                        key={row.value}
                        onClick={() => {
                          void configure({
                            model: row.value,
                            effort: null,
                            ...(provider === 'openai' ? { provider: 'claude' } : {}),
                          });
                          setOpen(false);
                        }}
                      >
                        <span>
                          {row.displayName}
                          {row.resolvedModel && <small>{row.resolvedModel}</small>}
                          <small>{row.description}</small>
                        </span>
                        {provider !== 'openai' && model !== null && chosen?.value === row.value && (
                          <Check />
                        )}
                      </button>
                    ))}
                  {openaiModels.map((row) => (
                    <button
                      type="button"
                      role="option"
                      disabled={disabled}
                      aria-selected={provider === 'openai' && model === row.id}
                      key={`openai:${row.id}`}
                      onClick={() => {
                        void configure({ model: row.id, effort: null, provider: 'openai' });
                        setOpen(false);
                      }}
                    >
                      <span>
                        {row.displayName}
                        <small>OpenAI</small>
                      </span>
                      {provider === 'openai' && model === row.id ? (
                        <Check />
                      ) : (
                        <OpenAI size={13} />
                      )}
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
