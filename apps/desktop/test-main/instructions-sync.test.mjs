import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compare, copy } from '../src/instructionsSync.ts';

// Two places of files, as the file panel reaches them: paths are written in each place's style.
function places(contents) {
  const encoder = new TextEncoder();
  const all = new Map(
    Object.entries(contents).map(([target, files]) => [
      target,
      new Map(
        Object.entries(files).map(([path, text]) => [
          path,
          text === null ? null : encoder.encode(text),
        ]),
      ),
    ]),
  );
  const sep = (path) => (path.includes('\\') ? '\\' : '/');
  const children = (target, directory) => {
    const mark = sep(directory);
    const found = new Map();
    for (const [path, bytes] of all.get(target))
      if (path.startsWith(directory + mark)) {
        const [name, ...rest] = path.slice(directory.length + 1).split(mark);
        if (!found.has(name) || rest.length)
          found.set(name, rest.length || bytes === null ? 'directory' : 'file');
      }
    return found;
  };
  const files = {
    copies: [],
    async list(target, directory) {
      const found = children(target, directory);
      if (!found.size && !all.get(target).has(directory)) throw new Error('missing');
      return [...found].map(([name, kind]) => ({
        name,
        kind,
        size: kind === 'file' ? all.get(target).get(directory + sep(directory) + name).length : 0,
        mtime: 0,
      }));
    },
    async read(target, file) {
      const bytes = all.get(target).get(file);
      return { bytes, size: bytes.length, truncated: false };
    },
    async mkdir(target, directory) {
      if (!all.get(target).has(directory)) all.get(target).set(directory, null);
    },
    async transfer(_id, { from, to, conflict }) {
      let count = 0;
      for (const path of from.paths) {
        const name = path.split(sep(path)).at(-1);
        const destination = `${to.dir}/${name}`;
        if (all.get(to.target).get(destination) && conflict === 'skip') continue;
        all.get(to.target).set(destination, all.get(from.target).get(path));
        files.copies.push(destination);
        count++;
      }
      return { files: count, bytes: 0 };
    },
    text: (target, path) => new TextDecoder().decode(all.get(target).get(path)),
  };
  return files;
}

test('a project’s instructions and skills are compared and copied to the service, the rest left alone', async () => {
  const files = places({
    local: {
      'D:\\p': null,
      'D:\\p\\CLAUDE.md': '# 项目说明',
      'D:\\p\\CLAUDE.local.md': '本机',
      'D:\\p\\README.md': '不同步',
      'D:\\p\\.claude\\settings.json': '{}',
      'D:\\p\\.claude\\skills\\deploy\\SKILL.md': '部署',
      'D:\\p\\.claude\\skills\\deploy\\notes\\a.md': '附件',
      'D:\\p\\.claude\\commands\\ship.md': '发布',
      'D:\\p\\.claude\\agents\\review.md': '审阅',
      'D:\\p\\docs\\CLAUDE.md': '子目录的',
    },
    server: {
      '/data/state/native/r': null,
      '/data/state/native/r/CLAUDE.local.md': '本机',
      '/data/state/native/r/.claude/settings.local.json': '{}',
      '/data/state/native/r/.claude/commands/ship.md': '旧的发布',
    },
  });
  const local = { target: 'local', root: 'D:\\p', style: 'windows' };
  const server = { target: 'server', root: '/data/state/native/r', style: 'posix' };
  const found = await compare(files, local, server);
  assert.deepEqual(found, {
    added: [
      'CLAUDE.md',
      '.claude/skills/deploy/SKILL.md',
      '.claude/skills/deploy/notes/a.md',
      '.claude/agents/review.md',
    ],
    same: ['CLAUDE.local.md'],
    differ: ['.claude/commands/ship.md'],
  });
  // New files only, folders made as needed; what differs stays as it was.
  assert.equal(await copy(files, local, server, found.added, false), 4);
  assert.equal(
    files.text('server', '/data/state/native/r/.claude/skills/deploy/notes/a.md'),
    '附件',
  );
  assert.equal(files.text('server', '/data/state/native/r/.claude/commands/ship.md'), '旧的发布');
  // Then the different one too, replaced.
  assert.equal(await copy(files, local, server, found.differ, true), 1);
  assert.equal(files.text('server', '/data/state/native/r/.claude/commands/ship.md'), '发布');
  // The other way, everything is the same now; the service's own settings are none of it.
  const back = await compare(files, server, local);
  assert.deepEqual(back.added, []);
  assert.deepEqual(back.differ, []);
  assert.equal(back.same.length, 6);
});

test('a project with none of these files has nothing to copy', async () => {
  const files = places({
    local: { '/home/u/p': null, '/home/u/p/main.c': 'int main;' },
    server: {},
  });
  assert.deepEqual(
    await compare(
      files,
      { target: 'local', root: '/home/u/p', style: 'posix' },
      { target: 'server', root: '/data/state/native/r', style: 'posix' },
    ),
    { added: [], same: [], differ: [] },
  );
});
