export type Preview =
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'image'; data: string }
  | { kind: 'unavailable'; reason: string };
export type Attachment = { path: string; preview?: Preview };
export const attachmentText = (text: string, attachments: Attachment[]) =>
  [text.trim(), ...attachments.map((item) => `"${item.path.replace(/"/g, '\\"')}"`)]
    .filter(Boolean)
    .join('\n');

const quotedPathLine = /^"(?:[a-zA-Z]:[\\/]|\\\\|\/)(?:[^"\\]|\\.)*"$/;

// Splits a user message's raw text into its prompt text and any trailing quoted file-path lines,
// so the transcript doesn't repeat raw `"C:\...\file.pdf"` strings when attachment cards are shown.
export function splitUserMessage(
  rawText: string,
  storedAttachments: Attachment[] = [],
): { bodyText: string; attachments: Attachment[] } {
  const storedByPath = new Map(storedAttachments.map((item) => [item.path, item]));
  const lines = rawText.split(/\r?\n/);
  const extractedPaths: string[] = [];

  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    if (!last) {
      lines.pop();
      continue;
    }
    if (quotedPathLine.test(last)) {
      const unquoted = last.slice(1, -1).replace(/\\"/g, '"');
      extractedPaths.unshift(unquoted);
      lines.pop();
      continue;
    }
    if (storedByPath.size > 0 && last.startsWith('"') && last.endsWith('"')) {
      const unquoted = last.slice(1, -1).replace(/\\"/g, '"');
      if (storedByPath.has(unquoted)) {
        extractedPaths.unshift(unquoted);
        lines.pop();
        continue;
      }
    }
    break;
  }

  const seen = new Set<string>();
  const attachments: Attachment[] = [];
  for (const item of storedAttachments) {
    if (!seen.has(item.path)) {
      seen.add(item.path);
      attachments.push(item);
    }
  }
  for (const path of extractedPaths) {
    if (!seen.has(path)) {
      seen.add(path);
      attachments.push(storedByPath.get(path) ?? { path });
    }
  }

  const bodyText = attachments.length > 0 ? lines.join('\n').trim() : rawText;
  return { bodyText, attachments };
}
