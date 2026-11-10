// The notes are written for the repository, where a link to another of its files is a path. Shown in the
// program, such a link points at that file on GitHub as the version has it.
export function absoluteLinks(text: string, repository: string, version: string) {
  return text.replace(
    /\]\((?!https?:|#|mailto:)([^)\s]+)\)/g,
    (_link, path: string) => `](${repository}/blob/v${version}/${path.replace(/^\.?\//, '')})`,
  );
}
// GitHub's alerts in the notes (`> [!WARNING]`), which the program's Markdown does not know: each opens with its
// label in bold instead.
const labels: Record<string, string> = {
  NOTE: '提示',
  TIP: '提示',
  IMPORTANT: '重要',
  WARNING: '注意',
  CAUTION: '注意',
};
export function alertLabels(text: string) {
  return text.replace(
    /^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\n> /gm,
    (_alert, kind: string) => `> **${labels[kind]}** · `,
  );
}
// One version's section of CHANGELOG.md, without its heading; null when the file has none for it.
export function releaseSection(changelog: string, version: string) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const start = lines.indexOf(`## ${version}`);
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return (
    lines
      .slice(start + 1, end < 0 ? undefined : end)
      .join('\n')
      .trim() || null
  );
}
