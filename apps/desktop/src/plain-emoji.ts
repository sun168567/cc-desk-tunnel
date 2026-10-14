// Color emoji fonts paint these as pictures. The stored reply is unchanged; this only changes
// how it is drawn. The selector that forces a picture is removed. Marks with no text glyph
// are drawn as the plain character that says the same thing.

const textMark: Record<string, string> = {
  '\u2705': '\u2713', // ✅
  '\u274C': '\u2717', // ❌
  '\u274E': '\u2717', // ❎
  '\u2B55': '\u25CB', // ⭕
  '\u2B50': '\u2605', // ⭐
  '\u2757': '!', // ❗
  '\u2753': '?', // ❓
  '\u2755': '!', // ❕
  '\u2754': '?', // ❔
};

const fence = '^ {0,3}(?:`{3,}|~{3,})';
const codeSplit = new RegExp(
  `(${fence}[\\s\\S]*?(?:${fence}[^\\S\\n]*$|(?![\\s\\S]))|\`[^\`\\n]*\`)`,
  'm',
);

function presentAsText(text: string) {
  const withoutPicture = text.replaceAll('\uFE0F', '');
  return withoutPicture.replace(/\p{Extended_Pictographic}/gu, (char) => {
    const mark = textMark[char];
    if (mark) return mark;
    // Only the ones that default to a color picture need a text-presentation request.
    return /\p{Emoji_Presentation}/u.test(char) ? `${char}\uFE0E` : char;
  });
}

export function plainEmoji(text: string) {
  return text
    .split(codeSplit)
    .map((part, index) => (index % 2 ? part : presentAsText(part)))
    .join('');
}
