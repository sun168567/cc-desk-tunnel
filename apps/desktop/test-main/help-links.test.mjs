import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { articles } from '../src/help-content.ts';
import { helpAnchors } from '../../../scripts/help-anchors.mjs';

// Every place that opens the help, from the window's code or from the help's own text, opens something that is
// there: an article, and the heading it names. A renamed article or heading fails here, not with a "?" that leads
// nowhere.
const pages = new Set(['whats-new']);
const headings = new Map(
  articles.map((article) => [
    article.id,
    // A heading without an id is linked to by its words, as HelpCenter does.
    new Set(
      article.blocks.flatMap((block) => (block.kind === 'heading' ? [block.id ?? block.text] : [])),
    ),
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

test('the help links only to its own articles and headings', () => {
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
  for (const article of articles) {
    walk(article.blocks, article.id);
    for (const id of article.related ?? [])
      if (!headings.has(id)) broken.push(`${article.id}: related "${id}" (no such article)`);
  }
  assert.deepEqual(broken, []);
});
