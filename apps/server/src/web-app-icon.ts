export const escapeMarkup = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

export function webAppIcon(source: Buffer, text: string) {
  const letters = Array.from(new Intl.Segmenter().segment(text), ({ segment }) => segment).slice(
    0,
    3,
  );
  const label = letters.join('');
  const width = Math.max(
    160,
    52 +
      letters.reduce(
        (sum, letter) => sum + (/^[\w .-]$/.test(letter) && !/[MWmw]/.test(letter) ? 44 : 72),
        0,
      ),
  );
  const left = 496 - width;
  // Keep the shipped image and its alpha outline; the top strip ends above the terminal glyph.
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<defs>
  <image id="base" width="512" height="512" href="data:image/png;base64,${source.toString('base64')}"/>
  <mask id="shape" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512" style="mask-type:alpha"><use href="#base"/></mask>
</defs>
<use href="#base"/>
<g mask="url(#shape)">
  <path fill="#a4d6be" d="M${left} 16H496V128H${left + 24}Q${left} 128 ${left} 104Z"/>
  <text x="${490 - width / 2}" y="108" text-anchor="middle" font-family="'Segoe UI','Microsoft YaHei',sans-serif" font-size="72" font-weight="700" fill="#17191b">${escapeMarkup(label)}</text>
</g>
</svg>`);
}
