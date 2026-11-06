import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/store.ts';

const device = { id: randomUUID(), name: '台式机' };
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-move-'));
  let store = new SessionStore(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    store,
    session: store.create(randomUUID(), '会话', 'D:\\项目 甲', device),
    // The library as a service that starts on it finds it.
    reopen() {
      store.close();
      return (store = new SessionStore(directory));
    },
  };
}
// What a first native run leaves behind: the prompt it was given and a native session to resume.
function ran(store: SessionStore, sessionId: string) {
  const said = store.promptValues(sessionId);
  store.append(sessionId, randomUUID(), {
    type: 'native.session',
    nativeSessionId: sessionId,
    model: 'test',
    version: 'test',
  });
  return said.projectPath;
}

test('a session that never ran simply changes its project', (t) => {
  const { store, session } = fixture(t);
  assert.equal(store.move(session.id, 'D:\\项目 乙', device).projectPath, 'D:\\项目 乙');
  assert.equal(store.notice(session.id), '');
  assert.equal(store.promptValues(session.id).projectPath, 'D:\\项目 乙');
});

test('a move is told once with the next message, and the system prompt keeps its path until a compaction', (t) => {
  const { store, session } = fixture(t);
  assert.equal(ran(store, session.id), 'D:\\项目 甲');
  store.move(session.id, 'D:\\项目 乙', device);
  store.move(session.id, 'D:\\项目 丙', device);
  // Nothing compacted: the prompt is byte for byte what it was, whichever connection the run is on.
  assert.equal(ran(store, session.id), 'D:\\项目 甲');
  const notice = store.notice(session.id);
  // The notice names where the session is now and the path Claude knew, not the stops in between.
  assert.match(notice, /is now "D:\\\\项目 丙" \(it was "D:\\\\项目 甲"\)/);
  assert.doesNotMatch(notice, /乙/);
  assert.equal(store.notice(session.id), '');
  assert.equal(ran(store, session.id), 'D:\\项目 甲');
  // A later move is told against what Claude heard last, not against the prompt.
  store.move(session.id, 'D:\\项目 丁', device);
  assert.match(store.notice(session.id), /is now "D:\\\\项目 丁" \(it was "D:\\\\项目 丙"\)/);
  store.move(session.id, 'D:\\项目 甲', device);
  assert.match(store.notice(session.id), /is now "D:\\\\项目 甲" \(it was "D:\\\\项目 丁"\)/);
  store.move(session.id, 'D:\\项目 丙', device);

  // A compaction rewrites what follows the prompt; from the next run the prompt says the current path, and
  // there is nothing left to tell.
  store.compacted(session.id);
  assert.equal(store.notice(session.id), '');
  assert.equal(ran(store, session.id), 'D:\\项目 丙');
  assert.equal(store.get(session.id).session.prompt?.compacted, undefined);
  assert.equal(store.get(session.id).session.prompt?.told, undefined);
  assert.equal(store.notice(session.id), '');
});

test('moving back before anything was said leaves nothing to tell, and a running session cannot move', (t) => {
  const { store, session } = fixture(t);
  ran(store, session.id);
  store.move(session.id, 'D:\\项目 乙', device);
  store.move(session.id, 'D:\\项目 甲', device);
  assert.equal(store.notice(session.id), '');
  store.append(session.id, randomUUID(), {
    type: 'run.status',
    status: 'awaiting_approval',
    connectionId: randomUUID(),
    waiting: 'question',
  });
  assert.equal(store.get(session.id).session.activeRun?.waiting, 'question');
  assert.throws(() => store.move(session.id, 'D:\\项目 乙', device), /结束当前运行/);
});

test('a session taken to another computer tells Claude of the computer and its directory, once', (t) => {
  const { store, session } = fixture(t);
  ran(store, session.id);
  const laptop = { id: randomUUID(), name: '笔记本 "二"' };
  // The same path on another computer is still another place.
  store.move(session.id, 'D:\\项目 甲', laptop);
  const notice = store.notice(session.id);
  assert.match(notice, /another of their computers, "笔记本 \\"二\\""/);
  assert.match(notice, /is now "D:\\\\项目 甲" \(it was "D:\\\\项目 甲"\)/);
  assert.equal(store.notice(session.id), '');
  // A move on that computer afterwards is only a move.
  store.move(session.id, 'E:\\别处', laptop);
  assert.doesNotMatch(store.notice(session.id), /computers/);
  store.move(session.id, 'D:\\项目 甲', device);
  assert.match(store.notice(session.id), /"台式机"/);
});

test('a session from before computers were told apart becomes that of the first to use it, unannounced', (t) => {
  const made = fixture(t);
  const { session } = made;
  ran(made.store, session.id);
  made.store.database.exec(
    "UPDATE sessions SET metadata = json_remove(metadata, '$.device', '$.prompt.device')",
  );
  const store = made.reopen();
  assert.equal(store.get(session.id).session.device, undefined);
  assert.deepEqual(store.claim(session.id, device).device, device);
  assert.equal(store.notice(session.id), '');
  // It is claimed once: the next computer has to take it over.
  const laptop = { id: randomUUID(), name: '笔记本' };
  assert.deepEqual(store.claim(session.id, laptop).device, device);
  assert.deepEqual(
    store.named({ ...device, name: '新名字' }).map(({ id }) => id),
    [session.id],
  );
  assert.equal(store.get(session.id).session.device?.name, '新名字');
});

test('a session taken to a computer of another system is told how that one runs scripts', (t) => {
  const { store, session } = fixture(t);
  ran(store, session.id);
  assert.equal(store.promptValues(session.id).execution.platform, 'win32');
  const mac = { id: randomUUID(), name: 'MacBook', platform: 'darwin' as const };
  store.move(session.id, '/Users/me/项目', mac);
  const notice = store.notice(session.id);
  assert.match(notice, /From now on the device is that computer: macOS\./);
  assert.match(notice, /is now "\/Users\/me\/项目" \(it was "D:\\\\项目 甲"\)/);
  assert.match(notice, /replaces what was said of scripts and command lines/);
  assert.match(notice, /Begin it with cd -- '\/Users\/me\/项目'\./);
  assert.doesNotMatch(notice, /PowerShell/);
  assert.equal(store.notice(session.id), '');
  // The prompt stays what it was until a compaction: only then does it describe the Mac.
  assert.deepEqual(store.promptValues(session.id), {
    projectPath: 'D:\\项目 甲',
    execution: { platform: 'win32', shells: ['pwsh'] },
  });
  // A move on the Mac says nothing of systems again; the way back to Windows does.
  store.move(session.id, '/Users/me/别处', mac);
  assert.doesNotMatch(store.notice(session.id), /scripts and command lines/);
  store.move(session.id, 'D:\\项目 甲', device);
  assert.match(store.notice(session.id), /that computer: Windows\..*Set-Location -LiteralPath/s);
  store.compacted(session.id);
  store.move(session.id, '/Users/me/项目', mac);
  assert.deepEqual(store.promptValues(session.id).execution, {
    platform: 'darwin',
    shells: ['zsh'],
  });
});

test('other shells on the device, or another one preferred, are told once with the next message', (t) => {
  const { store, session } = fixture(t);
  ran(store, session.id);
  assert.equal(store.notice(session.id), '');
  // Git for Windows is installed: the device now has Git Bash as well.
  store.equip(device.id, ['pwsh', 'bash']);
  const added = store.notice(session.id);
  assert.match(
    added,
    /^\[CC Desk Tunnel: the shells the device runs scripts in changed\. This replaces/,
  );
  assert.match(added, /ssh device-bash <<'SH'/);
  assert.match(added, /Use whichever suits the task\./);
  assert.equal(store.notice(session.id), '');
  store.prefer(device.id, 'bash');
  assert.match(
    store.notice(session.id),
    /the user now prefers Git Bash for scripts on the device\..*The user prefers Git Bash: use it/s,
  );
  store.prefer(device.id, null);
  assert.match(
    store.notice(session.id),
    /no longer prefers a shell.*Use whichever suits the task/s,
  );
  // A preference for a shell the device does not have says nothing: there is nothing to choose between.
  store.equip(device.id, ['pwsh']);
  assert.match(store.notice(session.id), /shells the device runs scripts in changed/);
  store.prefer(device.id, 'bash');
  assert.equal(store.notice(session.id), '');
  // The prompt stays what it was until a compaction, and names what is there then.
  assert.deepEqual(store.promptValues(session.id).execution, {
    platform: 'win32',
    shells: ['pwsh'],
  });
  store.equip(device.id, ['pwsh', 'bash']);
  store.notice(session.id);
  store.compacted(session.id);
  assert.deepEqual(store.promptValues(session.id).execution, {
    platform: 'win32',
    shells: ['pwsh', 'bash'],
    shell: 'bash',
  });
});

test('a prompt from before shells were named keeps naming those of its first run after', (t) => {
  const made = fixture(t);
  const { session } = made;
  ran(made.store, session.id);
  made.store.database.exec(
    "UPDATE sessions SET metadata = json_remove(metadata, '$.prompt.shells', '$.prompt.shell')",
  );
  const store = made.reopen();
  store.equip(device.id, ['pwsh', 'bash']);
  // The prompt of its next run names Git Bash, so nothing is told.
  assert.equal(store.notice(session.id), '');
  assert.deepEqual(store.promptValues(session.id).execution.shells, ['pwsh', 'bash']);
});
