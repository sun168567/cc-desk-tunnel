import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkTarget, localPicture } from '../src/links.ts';
import { pictureNote, toolPictures } from '../src/pictures.ts';
import { t } from '../src/i18n.ts';

const windows = { projectPath: 'C:\\Work\\App', here: true, browser: false };
const mac = { projectPath: '/Users/me/app', here: true, browser: false };

test('web addresses open anywhere, other schemes not at all', () => {
  assert.deepEqual(linkTarget('https://example.com/a?b=1', null), {
    kind: 'web',
    url: 'https://example.com/a?b=1',
  });
  assert.equal(linkTarget('mailto:a@b.c', windows).kind, 'web');
  assert.equal(linkTarget('javascript:alert(1)', windows), null);
  assert.equal(linkTarget('ms-msdt:/id', windows), null);
  assert.equal(linkTarget('#section', windows), null);
  // Without a session there is no folder for a path to be in.
  assert.equal(linkTarget('src/a.ts', null), null);
});

test('paths are read as Markdown passed them on, with a line and column at the end', () => {
  // The Markdown parser percent-encodes backslashes, spaces and other letters.
  assert.deepEqual(linkTarget('C:%5Ca%20b%5C%E4%B8%AD%E6%96%87.md', windows), {
    kind: 'path',
    path: 'C:\\a b\\中文.md',
    line: undefined,
    column: undefined,
  });
  assert.deepEqual(linkTarget('C:/x/y.ts:12:3', windows), {
    kind: 'path',
    path: 'C:\\x\\y.ts',
    line: 12,
    column: 3,
  });
  assert.deepEqual(linkTarget('src/a.ts#L12-L20', windows), {
    kind: 'path',
    path: 'C:\\Work\\App\\src\\a.ts',
    line: 12,
    column: undefined,
  });
  assert.equal(linkTarget('./docs/../README.md', windows).path, 'C:\\Work\\App\\README.md');
  assert.equal(linkTarget('file:///C:/a%20b/x.png', windows).path, 'C:\\a b\\x.png');
  assert.equal(linkTarget('../other/x.md', mac).path, '/Users/me/other/x.md');
  assert.equal(linkTarget('file:///Users/me/a%20b.md', mac).path, '/Users/me/a b.md');
  assert.equal(linkTarget('/Users/me/app/src/', mac).path, '/Users/me/app/src/');
  assert.deepEqual(linkTarget('lib/b.py:7', mac), {
    kind: 'path',
    path: '/Users/me/app/lib/b.py',
    line: 7,
    column: undefined,
  });
});

test('a path this window cannot open says why', () => {
  // On a Windows project, a POSIX path is one on the service.
  assert.equal(linkTarget('/data/state/x.txt', windows).reason, 'server');
  assert.equal(linkTarget('C:%5Cx', mac).reason, 'windows');
  assert.equal(linkTarget('file://server/share/a.txt', windows).reason, 'share');
  assert.equal(linkTarget('~/notes.md', windows).reason, 'partial');
  assert.equal(linkTarget('src/a.ts', { ...windows, here: false }).reason, 'away');
  assert.equal(
    linkTarget('src/a.ts', { ...windows, here: false, browser: true }).reason,
    'browser',
  );
  // On a Mac, whether a POSIX path is the service's is for the desktop to find out.
  assert.equal(linkTarget('/data/state/x.txt', mac).kind, 'path');
});

test('a picture on this computer has an address of its own', () => {
  assert.equal(localPicture('C:\\a b\\x.png'), 'local-image://file/C%3A%5Ca%20b%5Cx.png');
});

test('pictures a tool looked at are taken out of its output', () => {
  const data = 'iVBORw0KGgo=';
  const output = JSON.stringify([
    { type: 'text', text: 'Read 1 image' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
  ]);
  assert.deepEqual(toolPictures(output), {
    text: 'Read 1 image',
    pictures: [{ type: 'image/png', data }],
  });
  assert.equal(pictureNote(t, { type: 'image/png', data }), '[图片 image/png · 1 KB]');
  // Anything else is output as it is.
  assert.equal(toolPictures('["image"]'), null);
  assert.equal(toolPictures('plain "image" text'), null);
  assert.equal(
    toolPictures(JSON.stringify([{ type: 'image', source: { type: 'url', url: 'https://x' } }])),
    null,
  );
});
