import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createProxyServer } from '../apps/server/src/server.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
async function availablePort(start) {
  for (let port = start; port < start + 20; port++) {
    const probe = createServer();
    const available = await new Promise((resolve, reject) => {
      probe.once('error', (error) =>
        error.code === 'EADDRINUSE' ? resolve(false) : reject(error),
      );
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error('No free local development port');
}
const apiPort = await availablePort(Number(process.env.PROXY_PORT ?? 8787));
const uiPort = await availablePort(Number(process.env.UI_PORT ?? 5173));
const token = process.env.PROXY_TOKEN ?? randomBytes(32).toString('base64url');
const local = process.env.PROXY_RUNTIME_DIR ?? join(root, '.local');
mkdirSync(local, { recursive: true });
const server = createProxyServer({
  token,
  dataDir: process.env.PROXY_DATA_DIR ?? join(local, 'sessions'),
  allowedOrigins: [`http://127.0.0.1:${uiPort}`, `http://localhost:${uiPort}`, 'file://', 'null'],
});
const serverUrl = await server.listen(apiPort);
const uiUrl = `http://127.0.0.1:${uiPort}`;
writeFileSync(
  join(local, 'dev-connection.json'),
  JSON.stringify({ serverUrl: serverUrl.replace('http', 'ws') + '/ws', uiUrl, token }, null, 2) +
    '\n',
  { encoding: 'utf8', mode: 0o600 },
);
console.log(`GUI: ${uiUrl}`);
console.log(`Simulation server: ${serverUrl}`);
console.log(`Login details: ${join(local, 'dev-connection.json')} (token is not logged)`);
const vite = spawn(
  process.execPath,
  [
    join(root, 'node_modules/vite/bin/vite.js'),
    '--config',
    join(root, 'apps/desktop/vite.config.ts'),
    '--port',
    String(uiPort),
  ],
  { cwd: root, stdio: 'inherit', windowsHide: true },
);
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  vite.kill();
  await server.close();
  process.exitCode = code;
}
vite.on('error', (error) => {
  console.error(error.message);
  void stop(1);
});
vite.on('exit', (code) => {
  if (!stopping) void stop(code ?? 1);
});
process.on('SIGINT', () => {
  void stop();
});
process.on('SIGTERM', () => {
  void stop();
});
