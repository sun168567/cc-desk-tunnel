import { useLayoutEffect, useRef } from 'react';
import { ArrowUp, RefreshCw, Shrink, Square } from 'lucide-react';
import type {
  Effort,
  NativeCapabilities,
  NativeMetrics,
  NativeSession,
  PermissionMode,
  Session,
} from '@cc-desk-tunnel/protocol';
import ComposerControls from './ComposerControls.tsx';
import { IconButton } from './ui.tsx';

export type Scenario = 'chat' | 'tool' | 'error';
// A draft that is only a slash and an optional command name opens the command menu.
const slashDraft = /^[/\\][^ \n]*$/;
const compactDraft = /^[/\\](compact)?$/;

export default function Composer({
  session,
  draft,
  setDraft,
  native,
  connected,
  busy,
  refreshing,
  ownsRun,
  inputDisabled,
  controlsDisabled,
  slashOpen,
  setSlashOpen,
  canCompact,
  scenario,
  setScenario,
  capabilities,
  nativeSession,
  metrics,
  send,
  compact,
  refresh,
  configure,
  stop,
}: {
  session: Session;
  draft: string;
  setDraft: (text: string) => void;
  native: boolean;
  connected: boolean;
  busy: boolean;
  refreshing: boolean;
  ownsRun: boolean;
  inputDisabled: boolean;
  controlsDisabled: boolean;
  slashOpen: boolean;
  setSlashOpen: (open: boolean) => void;
  canCompact: boolean;
  scenario: Scenario;
  setScenario: (scenario: Scenario) => void;
  capabilities: NativeCapabilities | null;
  nativeSession: NativeSession | null;
  metrics: NativeMetrics | null;
  send: () => void;
  compact: () => void;
  refresh: () => void;
  configure: (values: {
    model?: string | null;
    effort?: Effort | null;
    permissionMode?: PermissionMode;
  }) => Promise<void>;
  stop: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    // Grow with the draft; the stylesheet's max-height decides when scrolling takes over.
    if (!input.current) return;
    input.current.style.height = 'auto';
    input.current.style.height = `${input.current.scrollHeight}px`;
  }, [draft, session.id]);
  return (
    <div className="composer-area">
      {native && slashOpen && (
        <div className="slash-menu" role="listbox" aria-label="会话命令">
          <button
            type="button"
            role="option"
            aria-selected={true}
            disabled={controlsDisabled || !canCompact}
            onClick={compact}
          >
            <Shrink />
            <span>
              压缩上下文
              <small>
                {metrics?.context ? `已使用 ${metrics.context.percentage}%` : '/compact'}
              </small>
            </span>
          </button>
          <button
            type="button"
            role="option"
            aria-selected={false}
            disabled={controlsDisabled || refreshing}
            onClick={() => {
              setSlashOpen(false);
              setDraft('');
              refresh();
            }}
          >
            <RefreshCw />
            <span>
              刷新原生状态<small>上下文与订阅额度</small>
            </span>
          </button>
        </div>
      )}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          ref={input}
          aria-label="消息"
          placeholder="发送消息…"
          value={draft}
          disabled={inputDisabled}
          maxLength={16000}
          rows={3}
          onChange={(event) => {
            setDraft(event.target.value);
            setSlashOpen(native && slashDraft.test(event.target.value));
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setSlashOpen(false);
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (slashOpen && compactDraft.test(draft)) compact();
              else send();
            }
          }}
        />
        <div className="composer-toolbar">
          {!native ? (
            <label className="scenario-label">
              场景
              <select
                aria-label="模拟场景"
                value={scenario}
                onChange={(event) => setScenario(event.target.value as Scenario)}
                disabled={!!session.activeRun || busy}
              >
                <option value="chat">对话</option>
                <option value="tool">工具审批</option>
                <option value="error">上游错误</option>
              </select>
            </label>
          ) : (
            <div className="native-settings">
              <label className="scenario-label">
                审批
                <select
                  aria-label="审批模式"
                  value={session.permissionMode}
                  disabled={controlsDisabled}
                  onChange={(event) => {
                    void configure({ permissionMode: event.target.value as PermissionMode });
                  }}
                >
                  <option value="auto">原生自动审批</option>
                  <option value="default">原生手动审批</option>
                  <option value="plan">原生计划模式</option>
                  <option value="acceptEdits">原生接受编辑</option>
                </select>
              </label>
            </div>
          )}
          {native && (
            <ComposerControls
              key={session.id}
              model={session.model}
              effort={session.effort}
              capabilities={capabilities}
              nativeSession={nativeSession}
              metrics={metrics}
              disabled={controlsDisabled}
              configure={configure}
            />
          )}
          {session.activeRun && (
            <IconButton
              title="停止运行"
              className="stop-button"
              disabled={!connected || !ownsRun || busy}
              onClick={stop}
            >
              <Square />
            </IconButton>
          )}
          {(!session.activeRun || native) && (
            <button
              type="submit"
              className="icon-button send-button"
              aria-label="发送消息"
              title="发送消息"
              disabled={!draft.trim() || inputDisabled}
            >
              <ArrowUp />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
