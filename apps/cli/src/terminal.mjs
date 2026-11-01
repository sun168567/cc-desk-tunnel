// What a terminal program may have switched on in this terminal and not switched off when the connection ended:
// a hidden cursor, bracketed paste, focus and mouse reports, the keyboard protocols, the alternate screen.
export const RESTORE =
  '\x1b[?25h\x1b[?2004l\x1b[?1004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[<u\x1b[>4;0m\x1b[?1049l\x1b[0m';
// Ctrl+Q leaves the terminal running on the service and returns here; Claude Code does not use it.
export const DETACH = '\x11';

const size = (output) => ({
  cols: Math.min(400, Math.max(20, output.columns || 80)),
  rows: Math.min(160, Math.max(5, output.rows || 24)),
});

// Shows the session's terminal in this one until it ends (`exited`, with the CLI's exit code), Ctrl+Q leaves it
// (`detached`), another connection takes it (`taken`) or the connection is lost (`lost`). The service keeps the
// terminal through all but the first, and opening it again draws its current screen.
export async function relay(service, sessionId, input = process.stdin, output = process.stdout) {
  let terminalId;
  let finish;
  const done = new Promise((resolve) => (finish = resolve));
  const listen = (message) => {
    if (message.sessionId !== sessionId) return;
    if (message.type === 'terminal.opened') terminalId = message.terminalId;
    if (message.terminalId !== terminalId) return;
    if (message.type === 'terminal.data')
      // Acknowledged once written: the service holds back output the terminal has not taken yet.
      output.write(message.data, () =>
        service.send({ type: 'terminal.ack', sessionId, terminalId, bytes: message.bytes }),
      );
    else if (message.type === 'terminal.closed') finish({ how: 'exited', code: message.exitCode });
    else if (message.type === 'terminal.detached') finish({ how: 'taken' });
  };
  const type = (data) => {
    if (!terminalId) return;
    const text = String(data);
    const at = text.indexOf(DETACH);
    const typed = at < 0 ? text : text.slice(0, at);
    for (let offset = 0; offset < typed.length; offset += 8192)
      service.send({
        type: 'terminal.input',
        sessionId,
        terminalId,
        data: typed.slice(offset, offset + 8192),
      });
    if (at >= 0)
      service.request({ type: 'terminal.detach', sessionId, terminalId }).then(
        () => finish({ how: 'detached' }),
        () => finish({ how: 'detached' }),
      );
  };
  const resize = () =>
    terminalId && service.send({ type: 'terminal.resize', sessionId, terminalId, ...size(output) });
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
      continueSession: true,
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
