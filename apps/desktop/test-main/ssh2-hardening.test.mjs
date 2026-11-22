import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// An ssh2 server with the hardening `module` gives, and a client that, before signing in, asks for compression and
// sends `hostkeys-00@openssh.com` requests whose key text makes ssh2's key parser slow down quadratically
// (CVE-2025-70034). Runs in a process of its own: the hardening changes ssh2 for the whole process.
const flood = (module, harden = true) => `
import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(pathToFileURL(resolve('package.json')).href)});
const { serverAlgorithms } = ${harden} ? await import(${JSON.stringify(pathToFileURL(resolve(module)).href)}) : {};
const { Server, Client, utils } = require('ssh2');
const { sendPacket } = require('ssh2/lib/protocol/utils.js');
const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private], algorithms: serverAlgorithms });
let signIn;
const answered = new Promise((done) => (signIn = done));
server.on('connection', (client) => {
  client.on('authentication', (context) => { signIn(); context.reject(['publickey']); });
  client.on('error', () => {});
});
let last = performance.now(), stalled = 0;
setInterval(() => { const now = performance.now(); stalled = Math.max(stalled, now - last - 20); last = now; }, 20).unref();
server.listen(0, '127.0.0.1', () => {
  const client = new Client();
  client.on('error', () => {});
  client.on('handshake', async (negotiated) => {
    const protocol = client._protocol;
    const name = Buffer.from('hostkeys-00@openssh.com');
    // Only the header of an old-style PEM key, put together so that the repository's secret check sees no key.
    const key = Buffer.from(('-----BEGIN RSA ' + 'PRIVATE KEY-----\\n' + 'a:a\\r\\n'.repeat(6400)).slice(0, 32000) + 'x');
    const started = performance.now();
    for (let i = 0; i < 10; i++) {
      const writer = protocol._packetRW.write;
      const packet = writer.alloc(1 + 4 + name.length + 1 + 4 + key.length);
      let offset = writer.allocStart;
      packet[offset++] = 80;
      packet.writeUInt32BE(name.length, offset); offset += 4;
      offset += name.copy(packet, offset);
      packet[offset++] = 0;
      packet.writeUInt32BE(key.length, offset); offset += 4;
      key.copy(packet, offset);
      sendPacket(protocol, writer.finalize(packet));
    }
    await answered;
    console.log(JSON.stringify({ compress: negotiated.cs.compress, stalled: Math.round(stalled), ms: Math.round(performance.now() - started) }));
    process.exit(0);
  });
  client.connect({
    host: '127.0.0.1', port: server.address().port, username: 'x',
    privateKey: utils.generateKeyPairSync('ed25519').private,
    algorithms: { compress: ['zlib', 'none'] },
  });
});`;
function run(source) {
  return new Promise((done, fail) =>
    execFile(
      process.execPath,
      ['--input-type=module', '-e', source],
      { timeout: 60000 },
      (error, stdout, stderr) =>
        error ? fail(new Error(stderr || error.message)) : done(JSON.parse(stdout)),
    ),
  );
}

for (const module of [
  'apps/desktop/electron/ssh2-hardening.mjs',
  'apps/server/src/ssh2-hardening.ts',
])
  test(`${module} keeps an ssh2 server answering through crafted host-key requests before sign-in`, async () => {
    const result = await run(flood(module));
    assert.equal(result.compress, 'none');
    // Unhardened, each of the ten requests holds the process for tens to hundreds of milliseconds.
    assert.ok(result.stalled < 100, JSON.stringify(result));
  });
