import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ClientReleases } from '../src/client-release.ts';

test('only the newest three installers are kept; other files are left alone', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-client-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const version of ['0.2.0', '0.9.9', '0.10.0', '0.2.10', '1.0.0'])
    writeFileSync(join(directory, `CC-Desk-Tunnel-Setup-${version}-x64.exe`), version);
  writeFileSync(join(directory, 'notes.txt'), 'kept');
  const releases = new ClientReleases(directory);
  await releases.refresh();
  assert.equal(releases.current?.version, '1.0.0');
  assert.deepEqual(readdirSync(directory).sort(), [
    'CC-Desk-Tunnel-Setup-0.10.0-x64.exe',
    'CC-Desk-Tunnel-Setup-0.9.9-x64.exe',
    'CC-Desk-Tunnel-Setup-1.0.0-x64.exe',
    'notes.txt',
  ]);
});
