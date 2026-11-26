import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

// Text the user reads belongs in the catalogs of packages/i18n, not in the code. This finds the Chinese written in
// the program's code: in strings, templates, JSX text and regular expressions, not in comments. Files not yet moved
// to the catalogs are allowed what they hold now (`pending` in packages/i18n/literals.json), which only goes down;
// `kept` are those whose Chinese is not the program's text, each with why. packages/i18n/test/literals.test.ts
// holds the code to both. `node scripts/i18n-literals.mjs --write` sets `pending` to what is there now.
const root = fileURLToPath(new URL('..', import.meta.url));
export const listFile = join(root, 'packages/i18n/literals.json');
const scanned =
  /^(apps\/(desktop\/(src|electron)|cli\/src|server\/src)|packages\/protocol\/src)\/.*\.(ts|tsx|mjs|cjs|js)$/;
const tests = /(^|\/)(test|test-main|tests)\/|\.(test|spec)\./;
const chinese = /[　-〿㐀-鿿＀-￯]/;

export function files() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => scanned.test(file) && !tests.test(file));
}

const textKinds = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.JsxText,
  ts.SyntaxKind.RegularExpressionLiteral,
]);
// Each piece of Chinese text in a file: its line and the text.
export function literals(file) {
  const text = readFileSync(join(root, file), 'utf8');
  const kind = file.endsWith('x')
    ? ts.ScriptKind.TSX
    : file.endsWith('ts')
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const found = [];
  const visit = (node) => {
    if (textKinds.has(node.kind) && chinese.test(node.getText(source))) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push({ line: line + 1, text: node.getText(source).trim() });
    }
    ts.forEachChild(node, visit);
  };
  // Template pieces are tokens rather than children: walk them through the template's spans.
  const walk = (node) => {
    if (ts.isTemplateExpression(node)) {
      for (const part of [node.head, ...node.templateSpans.map((span) => span.literal)])
        visit(part);
      for (const span of node.templateSpans) walk(span.expression);
      return;
    }
    if (textKinds.has(node.kind)) return visit(node);
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

export const counts = () =>
  Object.fromEntries(
    files()
      .map((file) => [file, literals(file).length])
      .filter(([, count]) => count > 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

export const readList = () => JSON.parse(readFileSync(listFile, 'utf8'));

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const now = counts();
  if (process.argv.includes('--write')) {
    let kept = {};
    try {
      kept = readList().kept ?? {};
    } catch {}
    const pending = Object.fromEntries(Object.entries(now).filter(([file]) => !kept[file]));
    writeFileSync(listFile, JSON.stringify({ pending, kept }, null, 2) + '\n');
  }
  const total = Object.values(now).reduce((sum, count) => sum + count, 0);
  console.log(`${total} pieces of Chinese text in ${Object.keys(now).length} files.`);
  for (const file of process.argv.slice(2).filter((arg) => !arg.startsWith('--')))
    for (const { line, text } of literals(file))
      console.log(`${file}:${line}  ${text.slice(0, 120)}`);
}
