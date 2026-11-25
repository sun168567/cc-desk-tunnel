import { EVENTS_VERSION } from './service-events.ts';
import type { ServiceEvent, ServiceEventName } from './service-events.ts';

// An example of each event, for a plugin to be tried on.
const device = { id: '5b1f0a52-2f0e-4c63-8d6e-0d0f2b7a9c11', name: '书房电脑', platform: 'win32' };
const session = {
  session_id: '0f4d1c9e-6a53-4b0c-9a39-3c1d6a6f7b10',
  session_title: '整理设置页',
  project_path: 'D:\\work\\demo',
  device,
  run_id: 'c2a7c1de-1d0b-4a35-8f55-7f3f5e0a4d21',
  permission_mode: 'auto',
  context: { used_tokens: 84_000, window_tokens: 200_000 },
};
const wait_id = '7d0e6f2b-58a4-4c0b-8c35-1f5b9f3e2a60';
const examples: Record<ServiceEventName, Record<string, unknown>> = {
  ApprovalRequested: { ...session, wait_id, tool_name: 'Bash' },
  QuestionAsked: { ...session, wait_id, tool_name: 'AskUserQuestion' },
  TerminalWaiting: { ...session, wait_id },
  WaitResolved: { ...session, wait_id, waiting: 'approval', tool_name: 'Bash', allowed: true },
  BackgroundOnly: session,
  RunError: { ...session, code: 'cli_process_failed', message: 'Claude Code exited.' },
  RunEnded: { ...session, status: 'completed', duration_ms: 84_210 },
  DeviceOnline: { device },
  DeviceOffline: { device },
};
export function eventExample(name: string): ServiceEvent | undefined {
  if (!Object.hasOwn(examples, name)) return undefined;
  return {
    version: EVENTS_VERSION,
    hook_event_name: name as ServiceEventName,
    timestamp: new Date().toISOString(),
    ...examples[name as ServiceEventName],
  };
}
