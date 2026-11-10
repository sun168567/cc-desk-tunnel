import { useEffect, useRef, useState } from 'react';
import type { NativeMetrics } from '@cc-desk-tunnel/protocol';
import { usePopover } from './usePopover.ts';

// The native summary names its categories in English, and a newer CLI gives each a stable id as well; the common ones
// are translated, any other is shown as it came.
const categoryIds: Record<string, string> = {
  system_prompt: '系统提示词',
  system_tools: '系统工具',
  mcp_instructions: 'MCP 说明',
  mcp_tools: 'MCP 工具',
  custom_agents: '自定义智能体',
  memory_files: '记忆文件',
  skills: '技能',
  messages: '对话消息',
};
const categoryNames: Record<string, string> = {
  'System prompt': '系统提示词',
  'System tools': '系统工具',
  'MCP server instructions': 'MCP 说明',
  'MCP tools': 'MCP 工具',
  'Custom agents': '自定义智能体',
  'Memory files': '记忆文件',
  Skills: '技能',
  Messages: '对话消息',
};

// What the used part of the window is made of: a bar filled by the categories in proportion to each other, and a line
// per category. Free space is left out (the card already gives the remainder), and so are the compaction buffer and
// tools loaded on demand.
function ContextBreakdown({ context }: { context: NonNullable<NativeMetrics['context']> }) {
  const used = context.categories.filter((item) => item.kind === 'used' && item.tokens > 0);
  const total = used.reduce((sum, item) => sum + item.tokens, 0);
  if (!total) return null;
  const label = ({ id, name }: (typeof used)[number]) =>
    (id && categoryIds[id]) ?? categoryNames[name] ?? name;
  const size = (tokens: number) => `${tokens.toLocaleString('zh-CN')} tok`;
  return (
    <div className="context-breakdown">
      <div className="context-breakdown-bar" aria-hidden="true">
        {used.map((item, index) => (
          <span
            key={item.id ?? item.name}
            className={`part-${index % 6}`}
            style={{ width: `${(item.tokens / total) * 100}%` }}
          />
        ))}
      </div>
      <ul>
        {used.map((item, index) => (
          <li key={item.id ?? item.name}>
            <i className={`part-${index % 6}`} aria-hidden="true" />
            <span>{label(item)}</span>
            <b>{size(item.tokens)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

// How full the context window is, drawn as a ring that changes colour as it runs out. In the input box's toolbar,
// hovering or focusing it opens the figures. In the strip under the input box it comes with its percentage and,
// like the other parts of the strip, opens a card when clicked.
export default function ContextMeter({
  metrics,
  withPercent = false,
}: {
  metrics: NativeMetrics | null;
  withPercent?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const popover = usePopover();
  useEffect(() => {
    if (withPercent) return;
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setHovered(false);
    };
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setHovered(false);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [withPercent]);
  const context = metrics?.context;
  const used = context ? Math.min(100, Math.max(0, context.percentage)) : 0;
  const level = !context ? 'unknown' : used >= 90 ? 'full' : used >= 70 ? 'high' : 'ok';
  const ring = (
    <svg className={`context-ring ${level}`} viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" pathLength={100} />
      <circle
        className="context-ring-used"
        cx="10"
        cy="10"
        r="7.5"
        pathLength={100}
        strokeDasharray={`${used} 100`}
      />
    </svg>
  );
  if (withPercent) {
    const rows = context
      ? [
          ['已用', `${context.usedTokens.toLocaleString('zh-CN')} tok`],
          ['窗口', `${context.windowTokens.toLocaleString('zh-CN')} tok`],
          ['剩余', `${Math.max(0, 100 - context.percentage)}%`],
          ['模型', context.model],
        ]
      : [];
    return (
      <div className="session-bar-part context" ref={popover.container}>
        <button
          type="button"
          aria-label="上下文窗口"
          aria-expanded={popover.open}
          onClick={() => popover.setOpen((value) => !value)}
        >
          {ring}
          {context && <span>{context.percentage}%</span>}
        </button>
        {popover.open && (
          <div className="turn-stats-card" role="dialog" aria-label="上下文窗口" ref={popover.card}>
            <header>
              {ring}
              <strong>上下文窗口</strong>
              {context && <b>{context.percentage}%</b>}
            </header>
            {context ? (
              <>
                <dl>
                  {rows.map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
                <ContextBreakdown context={context} />
                <p>{new Date(context.measuredAt).toLocaleTimeString('zh-CN')} · 原生摘要</p>
              </>
            ) : (
              <p>{metrics?.errors?.context ?? '等待原生状态'}</p>
            )}
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      className="context-control"
      ref={container}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className="icon-button context-button"
        aria-label="上下文窗口"
        aria-expanded={hovered}
        title={context ? `上下文 ${context.percentage}%` : '上下文窗口'}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        onClick={() => setHovered(true)}
      >
        {ring}
      </button>
      {hovered && (
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
  );
}
