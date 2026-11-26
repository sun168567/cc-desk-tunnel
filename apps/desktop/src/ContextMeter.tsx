import { useEffect, useRef, useState } from 'react';
import type { NativeMetrics } from '@cc-desk-tunnel/protocol';
import { wordsText } from '@cc-desk-tunnel/i18n';
import { localeOf, useT } from './i18n.ts';
import { usePopover } from './usePopover.ts';

// The native summary names its categories in English, and a newer CLI gives each a stable id as well; the common ones
// are said in the window's words (session:context.category.<id>), any other is shown as it came.
const categories = [
  'system_prompt',
  'system_tools',
  'mcp_instructions',
  'mcp_tools',
  'custom_agents',
  'memory_files',
  'skills',
  'messages',
] as const;
type Category = (typeof categories)[number];
const categoryIds: Record<string, Category> = {
  'System prompt': 'system_prompt',
  'System tools': 'system_tools',
  'MCP server instructions': 'mcp_instructions',
  'MCP tools': 'mcp_tools',
  'Custom agents': 'custom_agents',
  'Memory files': 'memory_files',
  Skills: 'skills',
  Messages: 'messages',
};
const isCategory = (id: string | undefined): id is Category =>
  !!id && (categories as readonly string[]).includes(id);

// What the used part of the window is made of: a bar filled by the categories in proportion to each other, and a line
// per category. Free space is left out (the card already gives the remainder), and so are the compaction buffer and
// tools loaded on demand.
function ContextBreakdown({ context }: { context: NonNullable<NativeMetrics['context']> }) {
  const t = useT();
  const used = context.categories.filter((item) => item.kind === 'used' && item.tokens > 0);
  const total = used.reduce((sum, item) => sum + item.tokens, 0);
  if (!total) return null;
  const label = ({ id, name }: (typeof used)[number]) => {
    const category = isCategory(id) ? id : categoryIds[name];
    return category ? t(`session:context.category.${category}`) : name;
  };
  const size = (tokens: number) => `${tokens.toLocaleString(localeOf(t))} tok`;
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
  const t = useT();
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
          [t('session:context.used'), `${context.usedTokens.toLocaleString(localeOf(t))} tok`],
          [t('session:context.window'), `${context.windowTokens.toLocaleString(localeOf(t))} tok`],
          [t('session:context.left'), `${Math.max(0, 100 - context.percentage)}%`],
          [t('session:context.model'), context.model],
        ]
      : [];
    return (
      <div className="session-bar-part context" ref={popover.container}>
        <button
          type="button"
          aria-label={t('session:context.title')}
          aria-expanded={popover.open}
          onClick={() => popover.setOpen((value) => !value)}
        >
          {ring}
          {context && <span>{context.percentage}%</span>}
        </button>
        {popover.open && (
          <div
            className="turn-stats-card"
            role="dialog"
            aria-label={t('session:context.title')}
            ref={popover.card}
          >
            <header>
              {ring}
              <strong>{t('session:context.title')}</strong>
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
                <p>
                  {t('session:context.measured', {
                    time: new Date(context.measuredAt).toLocaleTimeString(localeOf(t)),
                  })}
                </p>
              </>
            ) : (
              <p>
                {metrics?.errors?.context
                  ? wordsText(t, metrics.errors.context)
                  : t('session:context.waiting')}
              </p>
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
        aria-label={t('session:context.title')}
        aria-expanded={hovered}
        title={
          context
            ? t('session:context.percent', { percent: context.percentage })
            : t('session:context.title')
        }
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        onClick={() => setHovered(true)}
      >
        {ring}
      </button>
      {hovered && (
        <div className="context-tooltip" role="tooltip">
          <strong>{t('session:context.title')}</strong>
          {context ? (
            <>
              <span>
                {t('session:context.usedLeft', {
                  used: context.percentage,
                  left: Math.max(0, 100 - context.percentage),
                })}
              </span>
              <span>
                {context.usedTokens.toLocaleString(localeOf(t))} /{' '}
                {context.windowTokens.toLocaleString(localeOf(t))} tokens
              </span>
              <small>
                {t('session:context.measured', {
                  time: new Date(context.measuredAt).toLocaleTimeString(localeOf(t)),
                })}
              </small>
            </>
          ) : (
            <span>
              {metrics?.errors?.context
                ? wordsText(t, metrics.errors.context)
                : t('session:context.waiting')}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
