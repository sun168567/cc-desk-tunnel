import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createI18n, languages, sourceLanguage } from '@cc-desk-tunnel/i18n';
import { helpArticles, helpShapes, starters } from '../src/help-content.ts';
import { helpAnchors } from '../../../scripts/help-anchors.mjs';

// The help in each language: its structure is written once (src/help-content.ts), its text in each language's
// catalog (help:articles).
const help = Object.fromEntries(
  languages.map((language) => [language, helpArticles(createI18n(language).t)]),
);

// Every place that opens the help, from the window's code or from the help's own text, opens something that is
// there: an article, and the heading it names. A renamed article or heading fails here, not with a "?" that leads
// nowhere.
const pages = new Set(['whats-new']);
const headings = new Map(
  helpShapes.map((article) => [
    article.id,
    new Set(article.blocks.flatMap((block) => (block.kind === 'heading' ? [block.id] : []))),
  ]),
);
const missing = (anchor) => {
  const [id, heading] = anchor.split('#');
  if (pages.has(id) && !heading) return null;
  if (!headings.has(id)) return `no article "${id}"`;
  if (heading && !headings.get(id).has(heading)) return `no heading "${heading}" in "${id}"`;
  return null;
};

test('the window points only at articles and headings the help has', () => {
  const directory = new URL('../src/', import.meta.url);
  const broken = readdirSync(directory)
    .filter((name) => /\.(tsx?|mjs)$/.test(name) && name !== 'help-content.ts')
    .flatMap((name) =>
      helpAnchors(readFileSync(new URL(name, directory), 'utf8')).flatMap((anchor) => {
        const why = missing(anchor);
        return why ? [`${name}: ${anchor} (${why})`] : [];
      }),
    );
  assert.deepEqual(broken, []);
});

test('the help links only to its own articles and headings, in every language', () => {
  const broken = [];
  const walk = (value, where) => {
    if (typeof value === 'string')
      for (const [, anchor] of value.matchAll(/\]\(#([^)]+)\)/g)) {
        const why = missing(anchor);
        if (why) broken.push(`${where}: #${anchor} (${why})`);
      }
    else if (Array.isArray(value)) value.forEach((item) => walk(item, where));
    else if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) {
        if (key === 'article' && typeof item === 'string' && missing(item))
          broken.push(`${where}: ${item} (${missing(item)})`);
        else walk(item, where);
      }
  };
  for (const [language, articles] of Object.entries(help))
    for (const article of articles) {
      walk(article.blocks, `${language} ${article.id}`);
      for (const id of article.related ?? [])
        if (!headings.has(id)) broken.push(`${article.id}: related "${id}" (no such article)`);
    }
  for (const starter of starters(createI18n(sourceLanguage).t))
    if (missing(starter.article)) broken.push(`starter: ${starter.article}`);
  assert.deepEqual(broken, []);
});

test('every heading has an id of its own, and every block its text in the form its kind has', () => {
  for (const article of helpShapes) {
    const names = article.blocks.flatMap((block) =>
      'id' in block ? [block.id] : 'key' in block && block.key ? [block.key] : [],
    );
    assert.equal(new Set(names).size, names.length, `${article.id}: a name used twice`);
  }
  const text = (value) => typeof value === 'string' && value.length > 0;
  for (const [language, articles] of Object.entries(help))
    for (const article of articles) {
      const where = `${language} ${article.id}`;
      assert.ok(text(article.title) && text(article.lead) && text(article.words), where);
      article.blocks.forEach((block, index) => {
        const at = `${where} block ${index} (${block.kind})`;
        const shape = helpShapes.find((item) => item.id === article.id).blocks[index];
        switch (block.kind) {
          case 'p':
          case 'heading':
            return assert.ok(text(block.text), at);
          case 'list':
            return assert.ok(block.items.every(text), at);
          case 'steps':
            assert.equal(block.items.length, shape.targets.length, at);
            return block.items.forEach((step, place) => {
              assert.ok(text(step.title) && text(step.text), at);
              // A step leads somewhere exactly when it has the words of its button.
              assert.equal(!!step.action, !!shape.targets[place], `${at} step ${place}`);
            });
          case 'prompts':
            return assert.ok(
              block.items.every((item) => text(item.text)),
              at,
            );
          case 'callout':
            return assert.ok(text(block.title) && text(block.text), at);
          case 'figure':
            return assert.ok(block.caption === undefined || text(block.caption), at);
          case 'code':
            return assert.ok(text(block.text), at);
          case 'table':
            return assert.ok(
              block.head.length === 2 && block.rows.every((row) => row.length === 2),
              at,
            );
          case 'faq':
            return assert.ok(
              block.items.every((item) => text(item.q) && item.a.every(text)),
              at,
            );
          case 'actions':
            assert.equal(block.items.length, shape.targets.length, at);
            return assert.ok(
              block.items.every((item) => text(item.label)),
              at,
            );
        }
      });
    }
});

// What every language keeps as it is: where links go, the shortcuts it shows and the names it fills in.
const marks = (text) =>
  [...text.matchAll(/\]\(([^)]+)\)|\[\[\w+\]\]|\{\w+\}|\{\{\w+\}\}/g)]
    .map(([mark, target]) => target ?? mark)
    .sort();
test('every language keeps the help’s links, shortcuts and names', () => {
  const source = help[sourceLanguage];
  const strings = (value, path, out) => {
    if (typeof value === 'string') out.set(path, value);
    else if (Array.isArray(value))
      value.forEach((item, index) => strings(item, `${path}.${index}`, out));
    else if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value))
        if (key !== 'icon' && key !== 'target') strings(item, `${path}.${key}`, out);
    return out;
  };
  for (const language of languages.filter((item) => item !== sourceLanguage)) {
    const expected = strings(source, '', new Map());
    const actual = strings(help[language], '', new Map());
    assert.deepEqual([...actual.keys()], [...expected.keys()], language);
    for (const [path, text] of expected)
      assert.deepEqual(marks(actual.get(path)), marks(text), `${language}${path}`);
  }
});
