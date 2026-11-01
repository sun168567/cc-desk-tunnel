// Keys from the terminal one chunk at a time, until `handle` returns something other than undefined. The input is
// put back as it was afterwards and left open: reading it with `for await` would end the stream on the way out, and
// the terminal shown next would get no keys.
export function readKeys(input, handle) {
  return new Promise((resolve, reject) => {
    const done = (finish) => {
      input.off('data', data);
      input.off('end', ended);
      input.setRawMode?.(false);
      input.pause();
      finish();
    };
    const data = (chunk) => {
      try {
        const result = handle(String(chunk));
        if (result !== undefined) done(() => resolve(result));
      } catch (error) {
        done(() => reject(error));
      }
    };
    const ended = () => done(() => resolve(undefined));
    input.setRawMode?.(true);
    input.setEncoding('utf8');
    input.on('data', data);
    input.once('end', ended);
    input.resume();
  });
}
