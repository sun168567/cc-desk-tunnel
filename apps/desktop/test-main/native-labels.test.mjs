import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeLabels, serverFolders } from '../src/files.ts';

test('the service’s directories named by an ID say what project or session they work for', () => {
  const desk = { id: '11111111-1111-4111-8111-111111111111', name: '台式机' };
  const projectRoot = '22222222-2222-4222-8222-222222222222';
  const plainRoot = '33333333-3333-4333-8333-333333333333';
  const legacy = '44444444-4444-4444-8444-444444444444';
  const session = (id, title, nativeRoot) => ({ id, title, ...(nativeRoot ? { nativeRoot } : {}) });
  const label = nativeLabels(
    [
      { device: desk, path: 'D:\\工作\\中文项目', root: projectRoot, createdAt: '' },
      {
        device: desk,
        path: 'D:\\工作\\另一个',
        name: '起了名字',
        root: '55555555-5555-4555-8555-555555555555',
        createdAt: '',
      },
    ],
    [
      session('66666666-6666-4666-8666-666666666666', '项目里的会话', projectRoot),
      session('77777777-7777-4777-8777-777777777777', '普通会话甲', plainRoot),
      session(legacy, '更早的会话'),
    ],
  );
  // The project's name wins over its sessions'; a plain session's folder is its own.
  assert.equal(label(projectRoot), '中文项目 · 台式机');
  assert.equal(label('55555555-5555-4555-8555-555555555555'), '起了名字 · 台式机');
  assert.equal(label(plainRoot), '普通会话甲');
  assert.equal(label(legacy), '更早的会话');
  // The CLI's own record of a directory is named after its path.
  assert.equal(label(`-data-state-native-${projectRoot}`), '中文项目 · 台式机');
  assert.equal(label(projectRoot.toUpperCase()), '中文项目 · 台式机');
  // Anything else has nothing beside it.
  for (const name of [
    'native',
    'sessions.sqlite',
    `x${projectRoot}`,
    '88888888-8888-4888-8888-888888888888',
  ])
    assert.equal(label(name), undefined);
});

test('a session’s folders on the service: where Claude Code works, and where it keeps what it knows of that', () => {
  const files = { server: true, dataDir: '/data/state', home: '/data/home', protected: true };
  const root = '22222222-2222-4222-8222-222222222222';
  const session = { id: '66666666-6666-4666-8666-666666666666', nativeRoot: root };
  // A service that has not said where its CLI keeps its configuration offers neither.
  assert.equal(serverFolders(session, files), null);
  assert.deepEqual(serverFolders(session, { ...files, claude: '/data/home/.claude' }), {
    work: `/data/state/native/${root}`,
    records: `/data/home/.claude/projects/-data-state-native-${root}`,
  });
  // A session from before projects works in a directory of its own ID.
  assert.equal(
    serverFolders({ id: session.id }, { ...files, claude: '/c' })?.work,
    `/data/state/native/${session.id}`,
  );
  assert.equal(serverFolders(undefined, { ...files, claude: '/c' }), null);
});
