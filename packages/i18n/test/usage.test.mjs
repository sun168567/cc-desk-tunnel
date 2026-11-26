import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catalogs, namespaces } from '../src/catalogs.ts';
import { sourceLanguage } from '../src/index.ts';

// Every message of the catalogs is used by the code: named whole (`'session:tool.copyInput'`), or under a prefix
// the code completes (`` `session:mode.${mode}.name` ``), or by another message (`$t(…)`); a key of the default
// namespace, common, may be named without it. A message whose code is gone fails here, to be taken out.
const root = new URL('../../../', import.meta.url);
const folders = [
  'apps/desktop/src',
  'apps/desktop/electron',
  'apps/cli/src',
  'apps/server/src',
  'packages/protocol/src',
  'packages/i18n/src',
  'scripts',
];
function sources(folder) {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return name === 'locales' ? [] : sources(path);
    return /\.(tsx?|mjs|cjs|js)$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

test('every message is used by the code', () => {
  const code = folders
    .flatMap((folder) => sources(fileURLToPath(new URL(folder, root))))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  const flat = (tree, prefix = '') =>
    Object.entries(tree).flatMap(([key, value]) =>
      typeof value === 'string' || Array.isArray(value)
        ? [[prefix + key, value]]
        : flat(value, `${prefix}${key}.`),
    );
  const texts = namespaces.flatMap((namespace) =>
    flat(catalogs[sourceLanguage][namespace]).map(([, value]) => JSON.stringify(value)),
  );
  const named = new Set([...code.matchAll(/['"`]([a-z]+:[\w.-]+)['"`]/g)].map((match) => match[1]));
  const bare = new Set([...code.matchAll(/\bt\(\s*['"`]([\w.-]+)['"`]/g)].map((match) => match[1]));
  const prefixes = [...code.matchAll(/`([a-z]+:[\w.-]*)\$\{/g)].map((match) => match[1]);
  const nested = new Set(
    texts.flatMap((text) => [...text.matchAll(/\$t\(([a-z]+:[\w.-]+)/g)].map((match) => match[1])),
  );
  const unused = [];
  for (const namespace of namespaces) {
    const keys = new Set(
      flat(catalogs[sourceLanguage][namespace]).map(([key]) =>
        key.replace(/_(zero|one|two|few|many|other)$/, ''),
      ),
    );
    for (const key of keys) {
      const name = `${namespace}:${key}`;
      if (named.has(name) || nested.has(name) || (namespace === 'common' && bare.has(key)))
        continue;
      if (!prefixes.some((prefix) => name.startsWith(prefix))) unused.push(name);
    }
  }
  assert.deepEqual(unused, []);
});
