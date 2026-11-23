import { fstatSync, openSync } from 'node:fs';
import { isatty, ReadStream } from 'node:tty';

// What ccdt needs of the process before anything else reads it, for the ccdt the desktop client carries: that one runs
// with the client's program as Node, told so by ELECTRON_RUN_AS_NODE (scripts/package-windows.mjs).

// What ccdt starts, such as the commands Claude runs on this computer, must not run as Node.
delete process.env.ELECTRON_RUN_AS_NODE;

// The client's program is a windowed one: in a console window its output reaches the console, but its input is not
// the console's. Where the input is not redirected from a file or a pipe, it is read from the console itself.
if (process.platform === 'win32' && process.versions.electron && !isatty(0) && isatty(1)) {
  let redirected = false;
  try {
    const input = fstatSync(0);
    redirected = input.isFIFO() || input.isFile();
  } catch {
    // No input at all: the console's is the one there is.
  }
  if (!redirected)
    try {
      const input = new ReadStream(openSync('\\\\.\\CONIN$', 'r+'));
      // As Node's own standard input, it keeps the process going only while it is read: ccdt ends once it is done
      // with it.
      input.unref();
      input.on('resume', () => input.ref());
      input.on('pause', () =>
        process.nextTick(() => {
          if (!input.readableFlowing) input.unref();
        }),
      );
      Object.defineProperty(process, 'stdin', {
        value: input,
        configurable: true,
        enumerable: true,
      });
    } catch {
      // Without a console to read, ccdt goes on with the input it has.
    }
}
