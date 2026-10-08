import { StringDecoder } from 'node:string_decoder';

const clamp = (value, min, max) => Math.max(min, Math.min(max, Math.trunc(value)));
// The protocol's size bounds; a terminal outside them gets the nearest size the service accepts.
export const terminalSize = (output) => ({
  cols: clamp(output.columns || 80, 20, 400),
  rows: clamp(output.rows || 24, 5, 160),
});

// Input frames stay below the protocol limit without splitting a UTF-16 surrogate pair.
export function* inputFrames(text, size = 4096) {
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + size, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    yield text.slice(offset, end);
    offset = end;
  }
}

// What an abruptly ended CLI may leave switched on: hidden cursor, bracketed paste, focus and mouse reporting,
// the kitty keyboard protocol and the alternate screen.
export const TERMINAL_RESET =
  '\x1b[?25h\x1b[?2004l\x1b[?1004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[<u\x1b[?1049l';

// Ctrl+Q leaves a terminal running and returns to the list: as a control byte, or as the kitty keyboard protocol
// and xterm's modifyOtherKeys encode it when the CLI switched those on.
export const DETACH_KEY = /\x11|\x1b\[113;5(?::\d+)?u|\x1b\[27;5;113~/;

// Puts the user's own terminal in raw mode and joins it to a native Claude Code terminal of the session: keys go up
// as `terminal.input`, the size follows SIGWINCH, and output is acknowledged once the local terminal took it, which
// is the service's flow control. `exited` settles with the CLI's exit code, or rejects when the terminal could not
// open or the connection dropped. `continued` picks up the session's latest conversation.
//
// `exited` settles with `{ code }` when the CLI ended, or `{ detached: true }` after Ctrl+Q or `detach()`, when the
// CLI runs on in the service.
export function attachTerminal(
  connection,
  sessionId,
  { input = process.stdin, output = process.stdout, continued = false } = {},
) {
  let id = null;
  let pendingBytes = 0;
  let ackTimer;
  let attached = false;
  let finished = false;
  let closeRequested = false;
  const decoder = new StringDecoder('utf8');
  const initial = terminalSize(output);
  let size = `${initial.cols}:${initial.rows}`;
  let resolveExited, rejectExited;
  const exited = new Promise((resolve, reject) => {
    resolveExited = resolve;
    rejectExited = reject;
  });
  const acknowledge = () => {
    clearTimeout(ackTimer);
    ackTimer = undefined;
    if (!id || !pendingBytes || finished) return;
    connection.control({ type: 'terminal.ack', sessionId, terminalId: id, bytes: pendingBytes });
    pendingBytes = 0;
  };
  const onInput = (chunk) => {
    if (!id) return;
    let text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    const key = DETACH_KEY.exec(text);
    if (key) text = text.slice(0, key.index);
    for (const data of inputFrames(text))
      connection.control({ type: 'terminal.input', sessionId, terminalId: id, data });
    if (key) detach();
  };
  const onResize = () => {
    if (!id) return;
    const { cols, rows } = terminalSize(output);
    if (`${cols}:${rows}` === size) return;
    size = `${cols}:${rows}`;
    connection.control({ type: 'terminal.resize', sessionId, terminalId: id, cols, rows });
  };
  function detach() {
    if (finished || !id) return;
    void connection.request({ type: 'terminal.detach', sessionId, terminalId: id }).catch(() => {});
    finish(null, { detached: true });
  }
  const requestClose = () =>
    connection.request({ type: 'terminal.close', sessionId, terminalId: id }).catch(() => {});
  function finish(error, result) {
    if (finished) return;
    finished = true;
    clearTimeout(ackTimer);
    unsubscribe();
    if (attached) {
      input.off('data', onInput);
      output.off('resize', onResize);
      input.setRawMode?.(false);
      input.pause();
    }
    if (error) rejectExited(error);
    else resolveExited(result);
  }
  const unsubscribe = connection.onTerminal((message) => {
    if (message.sessionId !== sessionId || finished) return;
    if (message.type === 'terminal.opened' && !id) {
      id = message.terminalId;
      if (closeRequested) return void requestClose();
      attached = true;
      input.setRawMode?.(true);
      input.on('data', onInput);
      input.resume();
      output.on('resize', onResize);
      onResize();
    } else if (message.type === 'terminal.data' && message.terminalId === id) {
      output.write(message.data, () => {
        if (finished) return;
        pendingBytes += message.bytes;
        if (pendingBytes >= 16 * 1024) acknowledge();
        else ackTimer ??= setTimeout(acknowledge, 20);
      });
    } else if (message.type === 'terminal.closed' && message.terminalId === id) {
      finish(null, { code: message.exitCode });
    }
  });
  connection
    .request({ type: 'terminal.open', sessionId, ...initial, ...(continued && { continue: true }) })
    .catch((error) => finish(error));
  connection.closed.then((reason) => finish(new Error(reason ?? '连接已断开。')));
  return {
    exited,
    detach,
    // Ends the remote CLI; `exited` settles when the service reports it closed.
    close() {
      if (finished || closeRequested) return;
      closeRequested = true;
      if (id) void requestClose();
    },
  };
}
