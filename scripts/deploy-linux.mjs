import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { Client } from 'ssh2';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(readFileSync(resolve(process.argv[2] ?? '.local/deploy.json'), 'utf8'));
if (!config.host || !config.username || !/^SHA256:[A-Za-z0-9+/]+$/.test(config.fingerprint))
  throw new Error('Host, username and pinned SHA256 fingerprint required.');
const client = new Client();
await new Promise((resolve, reject) => {
  client.once('ready', resolve).once('error', reject);
  client.connect({
    host: config.host,
    port: config.port ?? 22,
    username: config.username,
    password: config.password,
    privateKey: config.privateKeyPath ? readFileSync(config.privateKeyPath) : undefined,
    readyTimeout: 15000,
    hostVerifier(key) {
      return (
        config.fingerprint ===
        'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
      );
    },
  });
});
function exec(command, input) {
  return new Promise((resolve, reject) =>
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      let stdout = '',
        stderr = '';
      stream.on('data', (data) => (stdout += data.toString('utf8')));
      stream.stderr.on('data', (data) => (stderr += data.toString('utf8')));
      stream.on('error', reject);
      stream.on('close', (code) =>
        code
          ? reject(new Error(`Remote command failed (${code}): ${stderr.slice(-3000)}`))
          : resolve(stdout),
      );
      if (input !== undefined) stream.end(input);
    }),
  );
}
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
try {
  const home = (await exec('printf %s "$HOME"')).trim();
  const base = `${home}/.local/share/cc-desk-tunnel`;
  console.log('Installing ordinary-user runtime...');
  console.log(await exec('bash -s', readFileSync(join(root, 'scripts/install-linux.sh'), 'utf8')));
  const local = join(root, '.local');
  mkdirSync(local, { recursive: true });
  const archive = join(local, 'service.tar.gz');
  execFileSync(
    process.platform === 'win32' ? 'tar.exe' : 'tar',
    [
      '-czf',
      archive,
      '--exclude=node_modules',
      '-C',
      root,
      'package.json',
      'package-lock.json',
      'apps/server',
      'apps/desktop/package.json',
      'packages/protocol',
    ],
    { windowsHide: true },
  );
  await exec(`mkdir -p ${quote(base + '/app')} ${quote(base + '/state')} ${quote(base + '/logs')}`);
  const certPath = `${base}/tls/server.crt`;
  const keyPath = `${base}/tls/server.key`;
  await exec(
    `umask 077; mkdir -p ${quote(base + '/tls')}; if [ ! -f ${quote(certPath)} ]; then openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 -subj '/CN=cc-desk-tunnel.local' -addext 'subjectAltName=DNS:cc-desk-tunnel.local' -addext 'basicConstraints=critical,CA:TRUE' -keyout ${quote(keyPath)} -out ${quote(certPath)} >/dev/null 2>&1; fi`,
  );
  const fingerprint = (
    await exec(`openssl x509 -in ${quote(certPath)} -noout -fingerprint -sha256`)
  )
    .trim()
    .split('=')
    .at(-1);
  const sftp = await new Promise((resolve, reject) =>
    client.sftp((error, channel) => (error ? reject(error) : resolve(channel))),
  );
  const upload = (local, remote) =>
    new Promise((resolve, reject) =>
      sftp.fastPut(local, remote, { mode: 0o600 }, (error) => (error ? reject(error) : resolve())),
    );
  await upload(archive, base + '/service.tar.gz');
  const token = config.token ?? randomBytes(32).toString('base64url');
  const port = config.servicePort ?? 8787;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || token.length < 24)
    throw new Error('Invalid service port or token');
  const settingsPath = config.settingsPath ?? `${base}/provider.json`;
  const env = {
    PROXY_TOKEN: token,
    PROXY_PORT: String(port),
    PROXY_HOST: '0.0.0.0',
    PROXY_PUBLIC_HOST: config.host,
    PROXY_TLS_CERT: certPath,
    PROXY_TLS_KEY: keyPath,
    FRPS_TLS_CERT: certPath,
    FRPS_TLS_KEY: keyPath,
    FRPS_SERVER_NAME: 'cc-desk-tunnel.local',
    FRPS_PATH: `${base}/runtime/frp/frps`,
    FRPS_PORT: String(config.frpsPort ?? 7000),
    CLAUDE_CONTEXT_RETENTION_DAYS: String(config.contextRetentionDays ?? 3650),
    PROXY_ADAPTER: 'claude-code',
    PROXY_DATA_DIR: `${base}/state`,
    CLAUDE_PATH: `${base}/runtime/cli/bin/claude`,
    ...(config.model ? { CLAUDE_MODEL: config.model } : {}),
    ...(config.provider || config.settingsPath ? { CLAUDE_SETTINGS_PATH: settingsPath } : {}),
  };
  const envFile = join(local, 'service.env');
  writeFileSync(
    envFile,
    Object.entries(env)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
  await upload(envFile, base + '/service.env');
  if (config.provider) {
    const providerFile = join(local, 'provider.local.json');
    writeFileSync(providerFile, JSON.stringify({ env: config.provider }, null, 2), { mode: 0o600 });
    await upload(providerFile, settingsPath);
  }
  console.log('Installing locked service dependencies...');
  console.log(
    await exec(
      `tar -xzf ${quote(base + '/service.tar.gz')} -C ${quote(base + '/app')}; cd ${quote(base + '/app')}; export PATH=${quote(base + '/runtime/node/bin')}:$PATH; npm ci --omit=dev --workspace=@cc-desk-tunnel/server --workspace=@cc-desk-tunnel/protocol`,
    ),
  );
  // Only stop the exact executable and script previously launched by this deployment.
  const script = `${base}/app/apps/server/src/main.ts`;
  console.log(
    await exec(
      `pid_file=${quote(base + '/service.pid')}; if [ -f "$pid_file" ]; then pid="$(cat "$pid_file")"; if [ -r "/proc/$pid/cmdline" ] && tr '\\0' '\\n' < "/proc/$pid/cmdline" | grep -Fxq ${quote(script)}; then kill -TERM "$pid"; for i in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done; fi; fi; cd ${quote(base + '/app')}; nohup ${quote(base + '/runtime/node/bin/node')} --env-file=${quote(base + '/service.env')} ${quote(script)} </dev/null >${quote(base + '/logs/service.log')} 2>&1 & echo $! > "$pid_file"; sleep 1; curl --cacert ${quote(certPath)} --resolve cc-desk-tunnel.local:${port}:127.0.0.1 -fsS https://cc-desk-tunnel.local:${port}/health`,
    ),
  );
  writeFileSync(
    join(local, 'native-connection.json'),
    JSON.stringify(
      {
        url: `wss://${config.host}:${port}/ws`,
        fingerprint,
        token,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    'Native service deployed. Pinned WSS address and secret token saved in .local/native-connection.json.',
  );
  sftp.end();
} finally {
  client.end();
}
