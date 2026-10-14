// A local file named in a reply. Inline code that is only a path (or relative path / filename with a
// recognized file extension), and a bare path in the sentence, become the same kind of card as an attached
// file. A fenced block stays source. An extension is required so a directory or a path still being written
// stays text; punctuation after the path stays in the sentence.

const extension = String.raw`[A-Za-z0-9]{1,12}`;
const knownFileExtensions = new Set([
  'md',
  'markdown',
  'mdx',
  'txt',
  'rst',
  'log',
  'csv',
  'tsv',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'svg',
  'xml',
  'json',
  'jsonc',
  'json5',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'properties',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'mts',
  'cts',
  'vue',
  'svelte',
  'astro',
  'py',
  'pyi',
  'ipynb',
  'rb',
  'php',
  'java',
  'kt',
  'kts',
  'scala',
  'groovy',
  'gradle',
  'go',
  'rs',
  'c',
  'h',
  'cc',
  'cpp',
  'cxx',
  'hpp',
  'hh',
  'hxx',
  'cs',
  'fs',
  'swift',
  'm',
  'mm',
  'dart',
  'lua',
  'pl',
  'r',
  'jl',
  'zig',
  'nim',
  'ex',
  'exs',
  'erl',
  'hrl',
  'clj',
  'hs',
  'ml',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'psm1',
  'psd1',
  'bat',
  'cmd',
  'sql',
  'sqlite',
  'prisma',
  'graphql',
  'gql',
  'proto',
  'dockerfile',
  'makefile',
  'cmake',
  'mk',
  'sln',
  'csproj',
  'vcxproj',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  ' lock',
  'lock',
  'patch',
  'diff',
]);

const proseBreak = String.raw`\\/:*?"<>|\s，。；、,;!！？）)】」"'` + '`';
const proseName = `[^${proseBreak}]+`;
const windowsInText = new RegExp(
  `(?<![A-Za-z:/])[A-Za-z]:[\\\\/](?:${proseName}[\\\\/])*${proseName}\\.${extension}`,
  'g',
);
const uncInText = new RegExp(
  `(?<![\\\\])\\\\\\\\${proseName}\\\\(?:${proseName}\\\\)*${proseName}\\.${extension}`,
  'g',
);
const posixInText = new RegExp(
  `(?<![A-Za-z0-9:/])/(?:${proseName}/)*${proseName}\\.${extension}`,
  'g',
);
const bareFileInText = new RegExp(
  `(?<![A-Za-z0-9_:/\\\\.])(?:${proseName}[\\\\/])*${proseName}\\.${extension}`,
  'g',
);

const windowsWhole =
  /^[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\\/:*?"<>|\r\n]+\.[A-Za-z0-9]{1,12}$/;
const uncWhole =
  /^\\\\[^\\/:*?"<>|\r\n]+\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]+\.[A-Za-z0-9]{1,12}$/;
const posixWhole = /^\/(?:[^/\r\n]+\/)*[^/\r\n]+\.[A-Za-z0-9]{1,12}$/;
const relativeWhole =
  /^(?:\.{1,2}[\\/])?(?:[^\\/:*?"<>|\r\n\s]+[\\/])*[^\\/:*?"<>|\r\n\s]+\.([A-Za-z0-9]{1,12})$/;

const fence = '^ {0,3}(?:`{3,}|~{3,})';
const codeSplit = new RegExp(
  `(${fence}[\\s\\S]*?(?:${fence}[^\\S\\n]*$|(?![\\s\\S]))|\`[^\`\\n]*\`)`,
  'm',
);

function quoted(value: string) {
  const text = value.trim();
  if (text.length >= 2 && text[0] === text.at(-1) && (text[0] === '"' || text[0] === "'"))
    return text.slice(1, -1).trim();
  return text;
}

export function isFilePath(value: string) {
  if (!value || value.length > 1024) return false;
  return windowsWhole.test(value) || uncWhole.test(value) || posixWhole.test(value);
}

export function isFileMentionTarget(value: string) {
  if (isFilePath(value)) return true;
  if (!value || value.length > 512 || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false;
  const match = value.match(relativeWhole);
  if (!match) return false;
  const ext = match[1].toLowerCase();
  if (!knownFileExtensions.has(ext)) return false;
  const base = value.split(/[\\/]/).pop() ?? '';
  const stem = base.slice(0, base.length - ext.length - 1);
  // Avoid matching plain version numbers like `1.0` or `v1.2.3`.
  if (!stem || /^v?\d+(?:\.\d+)*$/i.test(stem)) return false;
  return true;
}

const mentionPrefix = 'cc-file:';

function fileLink(path: string) {
  const name = path.split(/[\\/]/).pop() || path;
  const label = name.replace(/[\\[\]]/g, '\\$&');
  return `[${label}](${mentionPrefix}${encodeURIComponent(path)})`;
}

function mention(match: string) {
  return match.length > 1024 || !isFilePath(match) ? match : fileLink(match);
}

function bareMention(match: string, offset: number, source: string) {
  if (match.length > 512) return match;
  // Skip if already inside a markdown link `[label](...)` or URL.
  const lineStart = source.lastIndexOf('\n', offset) + 1;
  const before = source.slice(lineStart, offset);
  if (
    /\]\([^)]*$/.test(before) ||
    /\[[^\]]*$/.test(before) ||
    /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s]*$/i.test(before) ||
    /cc-file:[^\s)]*$/.test(before)
  )
    return match;
  const after = source.slice(offset + match.length, offset + match.length + 2);
  if (after.startsWith('](')) return match;
  return isFileMentionTarget(match) ? fileLink(match) : match;
}

function rewriteCode(part: string) {
  const inline = part.match(/^`([^`\n]*)`$/);
  if (!inline) return part;
  const path = quoted(inline[1]);
  return isFileMentionTarget(path) ? fileLink(path) : part;
}

function rewriteProse(part: string) {
  return part
    .replace(uncInText, mention)
    .replace(windowsInText, mention)
    .replace(posixInText, mention)
    .replace(bareFileInText, bareMention);
}

export function linkFilePaths(text: string) {
  return text
    .split(codeSplit)
    .map((part, index) => (index % 2 ? rewriteCode(part) : rewriteProse(part)))
    .join('');
}

export function pathFromMention(href: string | undefined) {
  if (!href?.startsWith(mentionPrefix)) return null;
  let path = href.slice(mentionPrefix.length);
  if (path.includes('%')) {
    try {
      path = decodeURIComponent(path);
    } catch {
      return null;
    }
  }
  return isFileMentionTarget(path) ? path : null;
}
