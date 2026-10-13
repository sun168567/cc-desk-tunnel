export type EditKind = 'Write' | 'Edit' | 'MultiEdit' | 'NotebookEdit';
export type EditChange = { oldText: string; newText: string };
export type EditInput = { kind: EditKind; path: string; changes: EditChange[]; partial?: boolean };
export type DiffLine = { type: 'add' | 'remove' | 'context'; number: number | null; text: string };

const EDIT_KINDS = new Set<EditKind>(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const stringValue = (value: unknown) => (typeof value === 'string' ? value : '');
const lineArray = (value: string) => value === '' ? [] : value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n$/u, '').split('\n');

function decodeJsonString(raw: string) {
  // Ignore only an unfinished escape at the streaming boundary; decode every complete
  // JSON escape with JSON.parse so escaped backslashes cannot become newlines.
  let end = raw.length;
  const incomplete = /\\u[0-9a-fA-F]{0,3}$/.exec(raw);
  if (incomplete) {
    let slashes = 0;
    for (let i = incomplete.index; i >= 0 && raw[i] === '\\'; i--) slashes++;
    if (slashes % 2) end = incomplete.index;
  }
  try { return JSON.parse(`"${raw.slice(0, end)}"`) as string; } catch { return ''; }
}
function partialString(raw: string, key: string) {
  const match = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`, 'u'));
  return match ? decodeJsonString(match[1]) : '';
}

export function parseEditInput(toolName: string, raw: string): EditInput | null {
  if (!EDIT_KINDS.has(toolName as EditKind)) return null;
  const kind = toolName as EditKind;
  try {
    const value: any = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const path = stringValue(value.file_path) || stringValue(value.notebook_path);
    if (!path) return null;
    if (kind === 'MultiEdit') {
      const edits = Array.isArray(value.edits) ? value.edits : [];
      return {
        kind,
        path,
        partial: false,
        changes: edits.filter((e: any) => e && typeof e === 'object').map((e: any) => ({ oldText: stringValue(e.old_string), newText: stringValue(e.new_string) })),
      };
    }
    const newText = kind === 'Write' ? value.content : kind === 'NotebookEdit' ? value.new_source : value.new_string;
    return { kind, path, partial: false, changes: [{ oldText: stringValue(value.old_string), newText: stringValue(newText) }] };
  } catch {
    return parsePartial(kind, raw);
  }
}
function parsePartial(kind: EditKind, raw: string): EditInput | null {
  const path = partialString(raw, 'file_path') || partialString(raw, 'notebook_path');
  if (!path) return null;
  if (kind === 'MultiEdit') {
    const changes: EditChange[] = []; const pair = /"old_string"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]*?"new_string"\s*:\s*"((?:\\.|[^"\\])*)/gu;
    let match: RegExpExecArray | null;
    while ((match = pair.exec(raw))) changes.push({ oldText: decodeJsonString(match[1]), newText: decodeJsonString(match[2]) });
    return { kind, path, partial: true, changes };
  }
  const key = kind === 'Write' ? 'content' : kind === 'NotebookEdit' ? 'new_source' : 'new_string';
  return { kind, path, partial: true, changes: [{ oldText: partialString(raw, 'old_string'), newText: partialString(raw, key) }] };
}

const diffCache = new Map<string, DiffLine[]>();

// While the tool call is still streaming, the new text is shown as added lines. Alignment waits until the
// JSON has closed, so a growing file does not rebuild a full comparison on every delta.
export function previewLines(change: EditChange): DiffLine[] {
  return lineArray(change.newText).map((text, index) => ({ type: 'add', number: index + 1, text }));
}

export function diffLines(change: EditChange, limit = 1500): DiffLine[] {
  const key = `${limit}\0${change.oldText}\0${change.newText}`;
  const cached = diffCache.get(key);
  if (cached) return cached;
  const lines = alignLines(change, limit);
  if (diffCache.size > 40) diffCache.clear();
  diffCache.set(key, lines);
  return lines;
}
function alignLines(change: EditChange, limit: number): DiffLine[] {
  const oldLines = lineArray(change.oldText), newLines = lineArray(change.newText);
  if (oldLines.length > limit || newLines.length > limit)
    return [...oldLines.map((text) => ({ type: 'remove' as const, number: null, text })), ...newLines.map((text, i) => ({ type: 'add' as const, number: i + 1, text }))];
  const lcs = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));
  for (let i = oldLines.length - 1; i >= 0; i--) for (let j = newLines.length - 1; j >= 0; j--)
    lcs[i][j] = oldLines[i] === newLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = []; let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) out.push({ type: 'context', number: j + 1, text: newLines[j] }), i++, j++;
    else if (i < oldLines.length && (j >= newLines.length || lcs[i + 1][j] >= lcs[i][j + 1])) out.push({ type: 'remove', number: null, text: oldLines[i++] });
    else out.push({ type: 'add', number: j + 1, text: newLines[j++] });
  }
  return out;
}
export function countChanges(input: EditInput | null) {
  if (!input) return { added: 0, removed: 0 };
  if (input.partial) {
    return {
      added: input.changes.reduce((total, change) => total + lineArray(change.newText).length, 0),
      removed: 0,
    };
  }
  return input.changes.reduce((total, change) => {
    for (const line of diffLines(change)) {
      if (line.type === 'add') total.added++;
      else if (line.type === 'remove') total.removed++;
    }
    return total;
  }, { added: 0, removed: 0 });
}
