import { readKeys } from './keys.mjs';

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
