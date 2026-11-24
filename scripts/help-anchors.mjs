// Where the window's code points into the help: the article, or `article#heading`, that a "?" or a setting opens.
// Shared by the test that every such place exists and by the release, which names the articles whose pointers
// changed since the last release so their text can be checked against what changed.
const patterns = [
  /\barticle="([^"]+)"/g,
  /\bhelp="([^"]+)"/g,
  /\bhelp: '([^']+)'/g,
  /\bopenHelp\('([^']+)'\)/g,
];
// The settings pages' own map from page to article.
const pageHelp = /const pageHelp[^=]*=\s*\{([\s\S]*?)\};/;

export function helpAnchors(source) {
  const found = patterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1]),
  );
  const map = pageHelp.exec(source)?.[1];
  if (map) found.push(...[...map.matchAll(/:\s*'([^']+)'/g)].map((match) => match[1]));
  return [...new Set(found)];
}
