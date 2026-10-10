import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { removeFrpLeftovers } from '../src/legacy.ts';

function deployment(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'legacy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = (name: string, text = 'x') => {
    writeFileSync(join(directory, name), text);
    return join(directory, name);
  };
  return { directory, file };
}

test('what frp left in the data directory and the settings file is removed, the rest is kept', (t) => {
  const { directory, file } = deployment(t);
  const env = {
    PROXY_TLS_CERT: file('control.crt'),
    PROXY_TLS_KEY: file('control.key'),
    FRPS_TLS_CERT: file('frp.crt'),
    FRPS_TLS_KEY: file('frp.key'),
  };
  const settings = file(
    'service.env',
    [
      "PROXY_TOKEN='secret'",
      "PROXY_PUBLIC_HOST='proxy.example.com'",
      "FRPS_TLS_CERT='/data/tls/frp.crt'",
      "FRPS_TLS_KEY='/data/tls/frp.key'",
      "FRPS_SERVER_NAME='cc-desk-tunnel.frp'",
      "PROXY_DATA_DIR='/data/state'",
      '',
    ].join('\n'),
  );
  removeFrpLeftovers(env, ['--experimental-x', `--env-file=${settings}`]);
  assert.equal(existsSync(env.FRPS_TLS_CERT), false);
  assert.equal(existsSync(env.FRPS_TLS_KEY), false);
  assert.equal(existsSync(env.PROXY_TLS_CERT), true);
  assert.equal(existsSync(env.PROXY_TLS_KEY), true);
  assert.equal(
    readFileSync(settings, 'utf8'),
    "PROXY_TOKEN='secret'\nPROXY_DATA_DIR='/data/state'\n",
  );
  assert.equal(existsSync(`${settings}.new`), false);
  // A second start finds nothing to do and leaves the file as it is.
  removeFrpLeftovers({}, [`--env-file=${settings}`]);
  assert.equal(
    readFileSync(settings, 'utf8'),
    "PROXY_TOKEN='secret'\nPROXY_DATA_DIR='/data/state'\n",
  );
  assert.equal(existsSync(join(directory, 'service.env.new')), false);
});

test("an frp setting that names the service's own certificate does not cost the service its certificate", (t) => {
  const { file } = deployment(t);
  const cert = file('shared.crt'),
    key = file('shared.key');
  removeFrpLeftovers(
    { PROXY_TLS_CERT: cert, PROXY_TLS_KEY: key, FRPS_TLS_CERT: cert, FRPS_TLS_KEY: key },
    [],
  );
  assert.equal(existsSync(cert), true);
  assert.equal(existsSync(key), true);
});

test('a deployment without frp settings, or started without a settings file, is left alone', (t) => {
  const { file } = deployment(t);
  const settings = file('service.env', "PROXY_TOKEN='secret'\n");
  removeFrpLeftovers({}, [`--env-file=${settings}`]);
  removeFrpLeftovers({}, []);
  removeFrpLeftovers({}, ['--env-file=/nonexistent/service.env']);
  assert.equal(readFileSync(settings, 'utf8'), "PROXY_TOKEN='secret'\n");
});
