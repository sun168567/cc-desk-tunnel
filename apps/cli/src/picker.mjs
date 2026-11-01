import { readKeys } from './keys.mjs';

// What fits in `columns` of the terminal, East Asian characters taking two and colours none; a line that wrapped
// would throw off drawing the list again in place.
export function fit(text, columns) {
  let width = 0;
  let kept = '';
  for (const [part] of text.matchAll(/\x1b\[[0-9;]*m|./gsu)) {
    if (part.length > 1 && part.startsWith('\x1b')) {
      kept += part;
      continue;
    }
    const wide =
      /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u.test(
        part,
      ) || part.codePointAt(0) >= 0x20000;
    if (width + (wide ? 2 : 1) > columns - 1) return `${kept}\x1b[0m…`;
    width += wide ? 2 : 1;
    kept += part;
  }
  return kept;
}

// A list to choose from with the arrow keys, as `claude --resume` offers its conversations. Enter chooses, Esc, q or
// Ctrl+C gives up (undefined); digits jump to an entry.
export async function pick(title, entries, input = process.stdin, output = process.stderr) {
  if (!input.isTTY) throw new Error('选择会话需要在终端里运行；也可以用 ccdt open <会话 ID>。');
  let at = 0;
  const window = Math.max(3, Math.min(entries.length, (output.rows || 24) - 4));
  let drawn = 0;
  const draw = () => {
    const top = Math.max(0, Math.min(at - window + 1, entries.length - window));
    const lines = [
      title,
      ...entries
        .slice(top, top + window)
        .map((entry) => fit(entry, (output.columns || 80) - 2))
        .map((entry, index) => (index + top === at ? `\x1b[7m❯ ${entry}\x1b[0m` : `  ${entry}`)),
      '\x1b[2m↑↓ 选择 · Enter 打开 · Esc 取消\x1b[0m',
    ];
    output.write(`${drawn ? `\x1b[${drawn}A` : ''}\x1b[J${lines.join('\n')}\n`);
    drawn = lines.length;
  };
  output.write('\x1b[?25l');
  draw();
  try {
    const chosen = await readKeys(input, (key) => {
      if (key === '\r' || key === '\n') return at;
      if (key === '\x1b' || key === 'q' || key === '\x03') return null;
      if (key === '\x1b[A' || key === 'k') at = (at + entries.length - 1) % entries.length;
      else if (key === '\x1b[B' || key === 'j') at = (at + 1) % entries.length;
      else if (/^[1-9]$/.test(key) && Number(key) <= entries.length) at = Number(key) - 1;
      draw();
    });
    return chosen ?? undefined;
  } finally {
    output.write('\x1b[?25h');
  }
}
