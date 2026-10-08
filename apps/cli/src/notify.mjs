import { spawn } from 'node:child_process';

// A desktop notification through notify-send, where there is one; CCDT_NOTIFY=0 switches them off.
export function notify(summary, body, env = process.env) {
  if (env.CCDT_NOTIFY === '0') return;
  try {
    const child = spawn('notify-send', ['--app-name=ccdt', summary, body], {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

// Agents of a `terminals.state` list that started waiting for the user since the previous one, leaving out those a
// terminal is showing: their user sees the prompt already.
export const newlyWaiting = (previous, terminals) =>
  terminals.filter(
    (terminal) =>
      terminal.status === 'waiting' &&
      !terminal.attached &&
      previous.get(terminal.sessionId)?.status !== 'waiting',
  );
