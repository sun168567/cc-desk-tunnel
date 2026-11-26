import { platformOf, terminalStatuses } from '@cc-desk-tunnel/protocol';
import type {
  AccountQuota,
  Device,
  NativeMetrics,
  PluginEvent,
  Session,
  SessionEvent,
} from '@cc-desk-tunnel/protocol';
import { textOf } from './errors.ts';

// The contract with plugins, described in docs/plugins.md. It is apart from the protocol between client and service:
// events and fields may be added to it freely, and none is removed or given another meaning, as plugins made for it
// go on being used. A later version would go only to the plugins that ask for it.
export const EVENTS_VERSION = 1;
export type ServiceEventName = PluginEvent;
export type ServiceEvent = {
  version: typeof EVENTS_VERSION;
  hook_event_name: ServiceEventName;
  timestamp: string;
  [field: string]: unknown;
};
// The field a hook's matcher is held against; the other events take no matcher.
export const matcherFields: Partial<Record<ServiceEventName, string>> = {
  ApprovalRequested: 'tool_name',
  WaitResolved: 'waiting',
  RunError: 'code',
  RunEnded: 'status',
};

type Wait = { waiting: 'approval' | 'question' | 'terminal'; tool_name?: string };
type Followed = {
  startedAt: number;
  tools: Map<string, string>;
  waits: Map<string, Wait>;
  error?: { code: string; message: string };
};
// What the service knows of a session as an event is made: its last figures, and the account's quota.
type Facts = { session: Session; metrics: NativeMetrics | null; quota: AccountQuota };

// As plugins are told of it, whatever becomes of the protocol's.
const told = (device: Device) => ({
  id: device.id,
  name: device.name,
  platform: platformOf(device),
});

// Makes the service's events out of what its sessions record. They say what happened and where, and nothing of what
// was said: no messages, no tool input or output.
export class ServiceEvents {
  private runs = new Map<string, Followed>();
  private facts: (sessionId: string) => Facts;
  private wanted: () => boolean;
  private emit: (event: ServiceEvent) => void;
  constructor(
    facts: (sessionId: string) => Facts,
    wanted: () => boolean,
    emit: (event: ServiceEvent) => void,
  ) {
    this.facts = facts;
    this.wanted = wanted;
    this.emit = emit;
  }
  device(name: 'DeviceOnline' | 'DeviceOffline', device: Device) {
    this.send(name, new Date().toISOString(), () => ({ device: told(device) }));
  }
  observe(event: SessionEvent) {
    const { payload, runId } = event;
    switch (payload.type) {
      case 'tool.requested':
        this.follow(event).tools.set(payload.toolId, payload.name);
        break;
      case 'tool.result':
        this.runs.get(runId)?.tools.delete(payload.toolId);
        break;
      case 'approval.requested': {
        const run = this.follow(event);
        const tool_name = run.tools.get(payload.toolId);
        const waiting = tool_name === 'AskUserQuestion' ? 'question' : 'approval';
        this.wait(event, payload.approvalId, { waiting, tool_name });
        break;
      }
      case 'approval.resolved':
        this.resolve(event, payload.approvalId, payload.allowed);
        break;
      case 'run.error': {
        // Words for a person, in the service's source language (see docs/plugins.md).
        const error = { code: payload.code, message: textOf(payload.phrase ?? payload.message) };
        this.follow(event).error = error;
        this.fire('RunError', event, error);
        break;
      }
      case 'run.status': {
        const run = this.follow(event);
        if (terminalStatuses.has(payload.status)) {
          for (const id of [...run.waits.keys()]) this.resolve(event, id);
          this.runs.delete(runId);
          if (payload.surface !== 'terminal')
            this.fire('RunEnded', event, {
              status: payload.status,
              reason: payload.reason && textOf(payload.reason),
              error: payload.status === 'failed' ? run.error : undefined,
              duration_ms: Date.parse(event.createdAt) - run.startedAt,
            });
        } else if (payload.surface === 'terminal') {
          if (payload.activity === 'waiting') this.wait(event, runId, { waiting: 'terminal' });
          else this.resolve(event, runId);
        } else if (payload.waiting === 'background') this.fire('BackgroundOnly', event);
      }
    }
  }
  private follow({ runId, createdAt }: SessionEvent) {
    let run = this.runs.get(runId);
    if (!run) {
      run = { startedAt: Date.parse(createdAt), tools: new Map(), waits: new Map() };
      this.runs.set(runId, run);
    }
    return run;
  }
  private wait(event: SessionEvent, id: string, wait: Wait) {
    this.follow(event).waits.set(id, wait);
    if (wait.waiting === 'terminal') this.fire('TerminalWaiting', event, { wait_id: id });
    else
      this.fire(wait.waiting === 'question' ? 'QuestionAsked' : 'ApprovalRequested', event, {
        wait_id: id,
        tool_name: wait.tool_name,
      });
  }
  // `allowed` is absent when nobody decided: the run ended, or the terminal does not say.
  private resolve(event: SessionEvent, id: string, allowed?: boolean) {
    const waits = this.runs.get(event.runId)?.waits;
    const wait = waits?.get(id);
    if (!wait) return;
    waits!.delete(id);
    this.fire('WaitResolved', event, { wait_id: id, ...wait, allowed });
  }
  private fire(name: ServiceEventName, event: SessionEvent, fields: Record<string, unknown> = {}) {
    this.send(name, event.createdAt, () => {
      const { session, metrics, quota } = this.facts(event.sessionId);
      const context = metrics?.context;
      return {
        session_id: session.id,
        session_title: session.title,
        project_path: session.projectPath,
        device: session.device && told(session.device),
        run_id: event.runId,
        model: context?.model ?? session.model ?? undefined,
        effort: session.effort ?? undefined,
        permission_mode: session.permissionMode,
        context: context
          ? { used_tokens: context.usedTokens, window_tokens: context.windowTokens }
          : undefined,
        quota: quota.rateLimits?.available
          ? quota.rateLimits.windows.map(({ name, utilization, resetsAt }) => ({
              name,
              utilization,
              resets_at: resetsAt,
            }))
          : undefined,
        ...fields,
      };
    });
  }
  // Nothing is looked up while no plugin is there, and nothing that goes wrong reaches the run that is told of.
  private send(name: ServiceEventName, timestamp: string, fields: () => Record<string, unknown>) {
    try {
      if (!this.wanted()) return;
      this.emit({ version: EVENTS_VERSION, hook_event_name: name, timestamp, ...fields() });
    } catch (error) {
      console.error(`Event ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
