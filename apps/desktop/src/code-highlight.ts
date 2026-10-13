import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
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

// Only the languages the diff panel names. This module is imported by the lazy diff panel, so the
// highlighter stays out of the main bundle.
const grammars = [
  ['bash', bash],
  ['c', c],
  ['cpp', cpp],
  ['csharp', csharp],
  ['css', css],
  ['go', go],
  ['java', java],
  ['javascript', javascript],
  ['json', json],
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
  html: 'xml',
  htm: 'xml',
  css: 'css',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
};

export function languageOf(filePath: string) {
  const base = filePath.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return extensions[base.slice(dot + 1).toLowerCase()] ?? null;
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
