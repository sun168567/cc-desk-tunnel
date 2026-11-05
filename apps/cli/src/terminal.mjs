// What a terminal program may have switched on in this terminal and not switched off when the connection ended:
// a hidden cursor, bracketed paste, focus and mouse reports, the keyboard protocols, the alternate screen.
export const RESTORE =
  '\x1b[?25h\x1b[?2004l\x1b[?1004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[<u\x1b[>4;0m\x1b[?1049l\x1b[0m';

const size = (output) => ({
  cols: Math.min(400, Math.max(20, output.columns || 80)),
  rows: Math.min(160, Math.max(5, output.rows || 24)),
});

// Shows the session's terminal in this one, every key passed on, until it ends (`exited`, with the CLI's exit code),
// another window takes it (`taken`), this one fell behind on its output (`stalled`) or the connection is lost
// (`lost`). The service keeps the terminal through the last three, and opening it again draws its current screen.
// `shown.terminalId` is the terminal being shown, for ending it when the window closes.
export async function relay(
  service,
  sessionId,
  shown = {},
  input = process.stdin,
  output = process.stdout,
) {
  let finish;
  const done = new Promise((resolve) => (finish = resolve));
  const listen = (message) => {
    if (message.sessionId !== sessionId) return;
    if (message.type === 'terminal.opened') shown.terminalId = message.terminalId;
    if (message.terminalId !== shown.terminalId) return;
    if (message.type === 'terminal.data')
      // Acknowledged once written: the service holds back output the terminal has not taken yet.
      output.write(message.data, () =>
        service.send({
          type: 'terminal.ack',
          sessionId,
          terminalId: shown.terminalId,
          bytes: message.bytes,
        }),
      );
    else if (message.type === 'terminal.closed') finish({ how: 'exited', code: message.exitCode });
    else if (message.type === 'terminal.detached') finish({ how: message.reason });
  };
  const type = (data) => {
    if (!shown.terminalId) return;
    const text = String(data);
    for (let offset = 0; offset < text.length; offset += 8192)
      service.send({
        type: 'terminal.input',
        sessionId,
        terminalId: shown.terminalId,
        data: text.slice(offset, offset + 8192),
      });
  };
  const resize = () =>
    shown.terminalId &&
    service.send({
      type: 'terminal.resize',
      sessionId,
      terminalId: shown.terminalId,
      ...size(output),
    });
  const lost = () => finish({ how: 'lost' });
  service.on('message', listen);
  service.on('end', lost);
  output.on('resize', resize);
  input.setRawMode?.(true);
  input.setEncoding('utf8');
  input.on('data', type);
  input.resume();
  try {
    await service.request({
      type: 'terminal.open',
      sessionId,
      ...size(output),
    });
    return await done;
  } finally {
    service.off('message', listen);
    service.off('end', lost);
    output.off('resize', resize);
    input.off('data', type);
    input.setRawMode?.(false);
    input.pause();
    output.write(RESTORE);
  }
}
