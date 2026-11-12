// Observe the pinned ws receiver without consuming or changing its input. The service sends uncompressed
// JSON with the snapshot type and requestId before its events. Other messages and control frames do not
// count as history progress, even when they arrive on the same connection.
export function observeHistoryPayload(receiver, progress) {
  const getData = receiver.getData;
  const limit = 64 * 1024;
  let prefix = Buffer.alloc(0);
  let requestId;
  let consumed = 0;
  let reported = 0;
  receiver.getData = function (callback) {
    if (this._opcode === 1 && !this._compressed) {
      const available = Math.min(this._payloadLength, this._bufferedBytes);
      let beginning;
      if (requestId === undefined && prefix.length < limit) {
        beginning = Buffer.concat([
          prefix,
          Buffer.concat(this._buffers, Math.min(available, limit - prefix.length)),
        ]);
        const text = beginning.toString('utf8');
        const start = '{"type":"session.snapshot",';
        if (text.startsWith(start)) requestId = /"requestId":"([^"]+)"/.exec(text)?.[1];
        else if (beginning.length >= start.length) requestId = null;
      }
      const received = consumed + available;
      if (requestId && received > reported) {
        progress(requestId, received - reported);
        reported = received;
      }
      if (available === this._payloadLength) {
        consumed = received;
        if (beginning) prefix = beginning;
        if (this._fin) {
          prefix = Buffer.alloc(0);
          requestId = undefined;
          consumed = reported = 0;
        }
      }
    }
    return getData.call(this, callback);
  };
}
