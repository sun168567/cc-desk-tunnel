import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stageDesktop } from '../../../scripts/package-desktop.mjs';

test(
  'desktop staging runs the optional Web entry without checkout dependencies and serves its shared icon',
  { timeout: 90_000 },
  async (t) => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    // Imports from here cannot fall back to this checkout's node_modules. The package must carry all
    // the dependencies of its optional Web entry, not just work when launched from the source tree.
    const temporaryRoot = await realpath(tmpdir());
    const directory = await mkdtemp(path.join(temporaryRoot, 'cc-desktop-web-package-'));
    const app = path.join(directory, 'app');
    const ownedDirectory = async () => {
      const resolved = await realpath(directory);
      assert.equal(path.dirname(resolved), temporaryRoot);
      assert.equal(path.basename(resolved), path.basename(directory));
      assert.ok(path.basename(resolved).startsWith('cc-desktop-web-package-'));
      assert.equal(path.isAbsolute(resolved), true);
      return resolved;
    };
    let server;
    try {
      // stageDesktop replaces files beneath app, and cleanup removes only this verified temporary root.
      await ownedDirectory();
      await stageDesktop(root, app, { description: 'Desktop Web packaging regression' });
      for (const file of [
        'proxy-bridge.mjs',
        'desktop-web.mjs',
        'web-auth.cjs',
        'web-requests.cjs',
      ])
        assert.ok((await stat(path.join(app, 'electron', file))).size > 0, `${file} is staged`);

      const stagedRequire = createRequire(path.join(app, 'electron/main.cjs'));
      for (const dependency of ['ws', '@cc-desk-tunnel/protocol'])
        assert.throws(() => stagedRequire.resolve(dependency), { code: 'MODULE_NOT_FOUND' });
      const bridge = await import(pathToFileURL(path.join(app, 'electron/proxy-bridge.mjs')).href);
      assert.equal(typeof bridge.openProxyBridge, 'function');
      assert.equal(typeof bridge.upgradeService, 'function');
      const runtime = await import(pathToFileURL(path.join(app, 'electron/desktop-web.mjs')).href);
      assert.deepEqual(Object.keys(runtime).sort(), ['createWebControl', 'startWebServer']);
      assert.equal(typeof runtime.createWebControl, 'function');
      assert.equal(typeof runtime.startWebServer, 'function');
      const control = runtime.createWebControl(async () => null);
      assert.equal(typeof control.attach, 'function');
      assert.equal(typeof control.publish, 'function');

      const connections = stagedRequire('./connections.cjs');
      assert.deepEqual(connections.list(path.join(directory, 'isolated-profile')), [
        { id: '', name: '主连接' },
      ]);
      // This CommonJS helper is loaded by main rather than by the bundled ESM entry.
      const { createWebRequests } = stagedRequire('./web-requests.cjs');
      let sent;
      const sender = { isDestroyed: () => false, send: (...args) => (sent = args) };
      const requests = createWebRequests({ window: () => ({ webContents: sender }) });
      const pending = requests.invoke('client:info', []);
      assert.equal(sent[0], 'remote:request');
      requests.reply(sender, { id: sent[1].id, ok: true, result: { connected: true } });
      assert.deepEqual(await pending, { connected: true });
      requests.cancel();
      const source = await readFile(path.join(app, 'electron/main.cjs'), 'utf8');
      assert.match(source, /import\(['"]\.\/desktop-web\.mjs['"]\)/);
      assert.doesNotMatch(source, /import\(['"](?:ws|@cc-desk-tunnel\/protocol)['"]\)/);

      const indexPath = path.join(app, 'dist/index.html');
      const html = await readFile(indexPath, 'utf8');
      const iconTag = html.match(/<link\b[^>]*\brel=["']icon["'][^>]*>/i)?.[0];
      assert.ok(iconTag, 'the shared page declares its favicon');
      assert.match(iconTag, /\btype=["']image\/png["']/);
      const iconHref = iconTag.match(/\bhref=["']([^"']+)["']/)?.[1];
      assert.match(iconHref, /^\.\/assets\/[^/?#]+\.png$/);
      const iconPath = fileURLToPath(new URL(iconHref, pathToFileURL(indexPath)));
      const originalIcon = await readFile(path.join(root, 'apps/desktop/electron/icon.png'));
      assert.deepEqual(await readFile(iconPath), originalIcon);
      assert.deepEqual(await readFile(path.join(app, 'electron/icon.png')), originalIcon);

      const token = 'test-only-desktop-package-pairing-token';
      server = await runtime.startWebServer({
        distDirectory: path.join(app, 'dist'),
        token,
        getInfo: () => ({ kind: 'desktop-web', connected: true }),
        invoke: async (method, args) => {
          assert.equal(method, 'client:info');
          assert.deepEqual(args, []);
          return { connected: true };
        },
      });
      const page = await fetch(server.url);
      assert.equal(page.status, 200);
      assert.equal(await page.text(), html);
      // The icon is public, but neither status nor operations are available before pairing.
      const iconResponse = await fetch(new URL(iconHref, `${server.url}/`));
      assert.equal(iconResponse.status, 200);
      assert.equal(iconResponse.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await iconResponse.arrayBuffer()), originalIcon);
      assert.equal((await fetch(`${server.url}/api/info`)).status, 401);
      const headers = { 'Content-Type': 'application/json', Origin: server.url };
      const operation = JSON.stringify({ method: 'client:info', args: [] });
      assert.equal(
        (await fetch(`${server.url}/api/rpc`, { method: 'POST', headers, body: operation })).status,
        401,
      );
      const paired = await fetch(`${server.url}/api/login`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ token }),
      });
      assert.equal(paired.status, 200);
      const setCookie = paired.headers.get('set-cookie');
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/);
      const Cookie = setCookie.split(';')[0];
      const info = await fetch(`${server.url}/api/info`, { headers: { Cookie } });
      assert.equal(info.status, 200);
      assert.deepEqual(await info.json(), { kind: 'desktop-web', connected: true });
      const response = await fetch(`${server.url}/api/rpc`, {
        method: 'POST',
        headers: { ...headers, Cookie },
        body: operation,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { result: { connected: true } });
      const crossOrigin = await fetch(`${server.url}/api/rpc`, {
        method: 'POST',
        headers: { ...headers, Cookie, Origin: 'http://example.invalid' },
        body: operation,
      });
      assert.equal(crossOrigin.status, 403);
      assert.equal(
        (
          await fetch(`${server.url}/api/logout`, {
            method: 'POST',
            headers: { ...headers, Cookie },
            body: '{}',
          })
        ).status,
        200,
      );
      assert.equal((await fetch(`${server.url}/api/info`, { headers: { Cookie } })).status, 401);
      t.diagnostic(
        `Shared favicon: ${iconHref}; ${originalIcon.length} bytes; SHA256 ${createHash('sha256').update(originalIcon).digest('hex')}`,
      );
    } finally {
      await server?.close();
      await rm(await ownedDirectory(), { recursive: true, force: true, maxRetries: 5 });
    }
  },
);
