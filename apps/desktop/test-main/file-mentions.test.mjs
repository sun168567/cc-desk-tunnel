import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isFilePath, linkFilePaths, pathFromMention } from '../src/file-mentions.ts';

const report = String.raw`E:\Working-Folder\Project\zuojun\asw\cstudio_release\功能评估报告.md`;

test('a path in inline code becomes a file mention and keeps the path', () => {
  const linked = linkFilePaths(`评估报告已写好，放在 \`${report}\`，共 85 行。`);
  assert.match(linked, /共 85 行/);
  assert.doesNotMatch(linked, /`E:\\/);
  const href = linked.match(/\(cc-file:([^)]+)\)/)?.[1];
  assert.equal(pathFromMention(`cc-file:${href}`), report);
});

test('a bare path in a sentence is recognized, and the following punctuation stays', () => {
  const linked = linkFilePaths(`放在 ${report}，共 85 行。`);
  assert.match(linked, /，共 85 行。$/);
  assert.equal(pathFromMention(`cc-file:${linked.match(/\(cc-file:([^)]+)\)/)?.[1]}`), report);
});

test('fenced code, ordinary inline code and web addresses stay as written', () => {
  const fenced = '```\nE:\\Work\\a.md\n```\n';
  assert.equal(linkFilePaths(fenced), fenced);
  assert.equal(linkFilePaths('use `npm test` here'), 'use `npm test` here');
  assert.equal(
    linkFilePaths('see https://example.com/dir/a.md'),
    'see https://example.com/dir/a.md',
  );
});

test('posix paths and quoted inline paths count, relative paths do not', () => {
  assert.equal(isFilePath('/home/me/项目/a.md'), true);
  assert.equal(isFilePath('src/a.md'), false);
  assert.equal(isFilePath(report), true);
  const linked = linkFilePaths('`"E:\\Work\\note.md"`');
  assert.equal(
    pathFromMention(`cc-file:${linked.match(/\(cc-file:([^)]+)\)/)?.[1]}`),
    String.raw`E:\Work\note.md`,
  );
});

test('bare filenames and relative paths with known extensions also become file mentions', () => {
  const linked = linkFilePaths(
    '方案已写成文档：`E:\\Work\\多核与多APP适配支持方案.md`，和 `功能评估报告.md` 放在同一目录，也可参考 docs/架构说明.md。',
  );
  const hrefs = [...linked.matchAll(/\(cc-file:([^)]+)\)/g)].map((m) =>
    pathFromMention(`cc-file:${m[1]}`),
  );
  assert.deepEqual(hrefs, [
    'E:\\Work\\多核与多APP适配支持方案.md',
    '功能评估报告.md',
    'docs/架构说明.md',
  ]);
});

test('markdown keeps the path through to the link', () => {
  const linked = linkFilePaths(`放在 \`${report}\`，共 85 行。`);
  let seen = '';
  const html = renderToStaticMarkup(
    React.createElement(Markdown, {
      remarkPlugins: [remarkGfm],
      urlTransform: (url) => (url.startsWith('cc-file:') ? url : defaultUrlTransform(url)),
      children: linked,
      components: {
        a: ({ href, children }) => {
          seen = pathFromMention(href) ?? '';
          return React.createElement('span', { 'data-path': seen }, children);
        },
      },
    }),
  );
  assert.equal(seen, report);
  assert.match(html, /data-path="[^"]*功能评估报告\.md"/);
  assert.match(html, /功能评估报告\.md/);
});
