import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

// Only the languages the diff panel and markdown code blocks name.
const grammars = [
  ['bash', bash],
  ['c', c],
  ['cpp', cpp],
  ['csharp', csharp],
  ['css', css],
  ['diff', diff],
  ['dockerfile', dockerfile],
  ['go', go],
  ['ini', ini],
  ['java', java],
  ['javascript', javascript],
  ['json', json],
  ['makefile', makefile],
  ['markdown', markdown],
  ['php', php],
  ['powershell', powershell],
  ['python', python],
  ['ruby', ruby],
  ['rust', rust],
  ['sql', sql],
  ['typescript', typescript],
  ['xml', xml],
  ['yaml', yaml],
] as const;
for (const [name, grammar] of grammars) hljs.registerLanguage(name, grammar);

const extensions: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  json: 'json',
  jsonc: 'json',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  css: 'css',
  scss: 'css',
  less: 'css',
  sh: 'bash',
  bash: 'bash',
  shell: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  pwsh: 'powershell',
  powershell: 'powershell',
  go: 'go',
  rs: 'rust',
  rust: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  csharp: 'csharp',
  rb: 'ruby',
  ruby: 'ruby',
  php: 'php',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'dockerfile',
  docker: 'dockerfile',
  makefile: 'makefile',
  mk: 'makefile',
  md: 'markdown',
  markdown: 'markdown',
  typescript: 'typescript',
  javascript: 'javascript',
  python: 'python',
};

export function languageOf(filePath: string) {
  const base = filePath.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return extensions[base.slice(dot + 1).toLowerCase()] ?? null;
}

export function languageFromCodeBlock(className: string | undefined, source: string): string | null {
  const match = className?.match(/\blanguage-([A-Za-z0-9_+-]+)\b/);
  if (match) {
    const tag = match[1].toLowerCase();
    if (extensions[tag]) return extensions[tag];
    if (hljs.getLanguage(tag)) return tag;
  }
  const trimmed = source.trim();
  if (!trimmed) return null;
  // Detect PowerShell / Bash scripts when untagged (e.g. `# comment` + commands or `.\script.ps1`)
  if (/^\s*#[^\n]*\n[\s\S]*(?:\.\\|\.[a-z0-9]+\s+-[A-Za-z])/m.test(trimmed) || /\.ps1\b/i.test(trimmed)) {
    return 'powershell';
  }
  if (/^(?:#!\/bin\/(?:ba|z)?sh|\s*#[^\n]*\n\s*(?:npm|pnpm|yarn|git|docker|curl|cd|export|sudo|apt|brew)\b)/m.test(trimmed)) {
    return 'bash';
  }
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    if (/"[^"]+"\s*:/.test(trimmed)) return 'json';
  }
  return null;
}

const lineCache = new Map<string, string | null>();

// One line. highlight.js escapes the source, so the HTML can go straight into the row.
export function highlightLine(text: string, language: string | null) {
  if (!language || text === '') return null;
  const key = `${language}\0${text}`;
  const cached = lineCache.get(key);
  if (cached !== undefined) return cached;
  let value: string | null = null;
  try {
    value = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    value = null;
  }
  if (lineCache.size > 4000) lineCache.clear();
  lineCache.set(key, value);
  return value;
}

// A whole file. highlight.js escapes the source, so the HTML can go straight into the drawer.
export function highlightSource(text: string, language: string | null) {
  if (!language || text === '') return null;
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
