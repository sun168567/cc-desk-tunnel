import { isWindowsPath } from '@cc-desk-tunnel/protocol';

// A file put in a message is its path in double quotes, where it was put (see MessageInput): Claude reads the file
// from there. The window shows such a path as the file it is; what is sent, kept and copied is still the text.
export type Piece = { text: string } | { path: string };

// The paths of the computer the session's project is on: a drive path on Windows; elsewhere an absolute path of more
// than one part, so that a quoted "/command" stays words.
const quoted = /"([A-Za-z]:\\[^"\r\n]*|\/[^"\r\n/]+\/[^"\r\n]*)"/g;

export function pieces(text: string, windows: boolean): Piece[] {
  const result: Piece[] = [];
  let at = 0;
  for (const match of text.matchAll(quoted)) {
    if (isWindowsPath(match[1]) !== windows) continue;
    if (match.index > at) result.push({ text: text.slice(at, match.index) });
    result.push({ path: match[1] });
    at = match.index + match[0].length;
  }
  if (at < text.length) result.push({ text: text.slice(at) });
  return result;
}
export const quote = (path: string) => `"${path}"`;
export const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;
