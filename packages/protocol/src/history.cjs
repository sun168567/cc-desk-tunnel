// Both the service and the desktop cache store the same event rows and page by whole runs.
const PAGE_EVENTS = 1000;
const PAGE_BYTES = 512 * 1024;

function readEvents(database, sessionId, after = 0, before = Number.MAX_SAFE_INTEGER) {
  return database
    .prepare(
      'SELECT data FROM events WHERE session_id = ? AND sequence > ? AND sequence < ? ORDER BY sequence',
    )
    .all(sessionId, after, before)
    .map((row) => JSON.parse(row.data));
}

function readHistory(database, sessionId, after = 0, before, lower = 0) {
  const last = Number(
    database
      .prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM events WHERE session_id = ?')
      .get(sessionId).value,
  );
  if (after > 0) {
    const size = database
      .prepare(
        'SELECT COUNT(*) AS count, COALESCE(SUM(octet_length(data)), 0) AS bytes FROM events WHERE session_id = ? AND sequence > ?',
      )
      .get(sessionId, after);
    if (size.count <= PAGE_EVENTS && size.bytes <= PAGE_BYTES) {
      const events = readEvents(database, sessionId, after);
      return {
        mode: 'append',
        events,
        firstSequence: events[0]?.sequence ?? 0,
        lastSequence: last,
        hasEarlier: false,
      };
    }
  }
  const end = before ?? last + 1;
  const groups = database
    .prepare(
      'SELECT run_id, MIN(sequence) AS first FROM events WHERE session_id = ? AND sequence > ? AND sequence < ? GROUP BY run_id ORDER BY first DESC LIMIT 1000',
    )
    .all(sessionId, lower, end);
  const sizeOf = database.prepare(
    'SELECT COUNT(*) AS count, SUM(octet_length(data)) AS bytes FROM events WHERE session_id = ? AND run_id = ? AND sequence > ? AND sequence < ?',
  );
  let first = 0,
    count = 0,
    bytes = 0;
  for (const group of groups) {
    const size = sizeOf.get(sessionId, group.run_id, lower, end);
    if (first && (count + size.count > PAGE_EVENTS || bytes + size.bytes > PAGE_BYTES)) break;
    first = Number(group.first);
    count += Number(size.count);
    bytes += Number(size.bytes);
  }
  const events = first ? readEvents(database, sessionId, first - 1, end) : [];
  return {
    mode: before === undefined ? 'replace' : 'prepend',
    events,
    firstSequence: first,
    lastSequence: events.at(-1)?.sequence ?? 0,
    hasEarlier:
      !!first &&
      !!database
        .prepare(
          'SELECT 1 FROM events WHERE session_id = ? AND sequence > ? AND sequence < ? LIMIT 1',
        )
        .get(sessionId, lower, first),
  };
}
module.exports = { readEvents, readHistory };
