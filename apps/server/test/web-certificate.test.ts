import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer } from 'node:tls';
import { test, type TestContext } from 'node:test';
import { WebCertificates } from '../src/web-certificate.ts';
import {
  ca,
  clientOnly,
  custom,
  defaultCertificate,
  expired,
  future,
  renewed,
  wrongDomain,
} from './fixtures/web-certificates.ts';

const domain = 'web.example.test';
function fixture(t: TestContext) {
  const dataDir = fs.mkdtempSync(join(tmpdir(), 'cc-web-certificate-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const options = { dataDir, domain, tls: defaultCertificate };
  return { dataDir, options, certificates: new WebCertificates(options) };
}

test('imports the current pair, restores it at startup, and removes both files on reset', (t) => {
  const { dataDir, options, certificates } = fixture(t);
  assert.deepEqual(certificates.state(), { mode: 'default', selfSigned: true });
  assert.equal(fs.existsSync(join(dataDir, 'web')), false);
  certificates.set({ domain, ...custom });
  assert.equal(certificates.state().mode, 'custom');
  assert.equal(certificates.state().details?.domain, domain);
  assert.equal(certificates.state().selfSigned, false);
  assert.equal(certificates.state().details?.selfSigned, false);
  assert.ok(certificates.context(domain.toUpperCase()));
  assert.equal(certificates.context('other.example.test'), undefined);
  assert.deepEqual(fs.readdirSync(join(dataDir, 'web')).sort(), ['cert.pem', 'key.pem']);
  if (process.platform !== 'win32') {
    for (const name of ['cert.pem', 'key.pem'])
      assert.equal(fs.statSync(join(dataDir, 'web', name)).mode & 0o777, 0o600);
  }
  assert.equal(
    new WebCertificates(options).state().details?.fingerprint,
    certificates.state().details?.fingerprint,
  );
  assert.throws(() => certificates.validateDomain(''), /恢复默认证书/);
  assert.throws(() => certificates.validateDomain('other.example.test'), /恢复默认证书/);
  certificates.validateDomain(domain);
  certificates.set({ domain, ...renewed });
  assert.equal(fs.readFileSync(join(dataDir, 'web', 'key.pem'), 'utf8'), renewed.key);
  assert.deepEqual(fs.readdirSync(join(dataDir, 'web')).sort(), ['cert.pem', 'key.pem']);
  certificates.set({ domain: 'default.example.test', ...defaultCertificate });
  assert.equal(certificates.state().mode, 'custom');
  assert.equal(certificates.state().selfSigned, true);
  assert.equal(certificates.state().details?.selfSigned, true);
  certificates.reset();
  certificates.validateDomain('');
  assert.deepEqual(fs.readdirSync(join(dataDir, 'web')), []);
  assert.deepEqual(new WebCertificates(options).state(), { mode: 'default', selfSigned: true });
});

test('invalid PEM, dates, SAN, key and supplied-chain signatures never replace the serving pair', (t) => {
  const { dataDir, certificates } = fixture(t);
  certificates.set({ domain, ...custom });
  const context = certificates.context(domain);
  const leaf = custom.cert.slice(
    0,
    custom.cert.indexOf('-----END CERTIFICATE-----') + '-----END CERTIFICATE-----'.length,
  );
  const invalidRoot = Buffer.from(new X509Certificate(ca).raw);
  invalidRoot[invalidRoot.length - 1] ^= 1;
  const invalidChain = `${leaf}\n-----BEGIN CERTIFICATE-----\n${invalidRoot.toString('base64')}\n-----END CERTIFICATE-----`;
  for (const material of [
    { ...custom, cert: 'invalid' },
    expired,
    future,
    wrongDomain,
    clientOnly,
    { ...custom, key: defaultCertificate.key },
    { ...custom, cert: `${custom.cert}\n${ca}` },
    { ...custom, cert: `${leaf}\n${defaultCertificate.cert}` },
    { ...custom, cert: `${ca}\n${leaf}` },
    { ...custom, cert: invalidChain },
    { ...custom, key: `${custom.key}\nextra` },
    { ...custom, cert: ' '.repeat(65537) },
  ]) {
    assert.throws(() => certificates.set({ domain, ...material }));
    assert.equal(certificates.context(domain), context);
    assert.equal(fs.readFileSync(join(dataDir, 'web', 'cert.pem'), 'utf8'), custom.cert);
    assert.equal(fs.readFileSync(join(dataDir, 'web', 'key.pem'), 'utf8'), custom.key);
  }
  assert.throws(() => certificates.set({ domain: '', ...custom }), /Web 对外地址中填写域名/);
});

test('invalid saved material leaves original TLS usable and can be reset even without a domain', (t) => {
  const { dataDir, options, certificates } = fixture(t);
  certificates.set({ domain, ...custom });
  const restored = new WebCertificates({ ...options, domain: '' });
  assert.equal(restored.state().mode, 'default');
  assert.match(restored.state().error!, /恢复默认证书/);
  restored.reset();
  assert.deepEqual(fs.readdirSync(join(dataDir, 'web')), []);
  assert.equal(restored.state().error, undefined);
  certificates.set({ domain, ...custom });
  fs.writeFileSync(join(dataDir, 'web', 'key.pem'), 'invalid');
  const corrupt = new WebCertificates(options);
  assert.equal(corrupt.state().mode, 'default');
  assert.ok(corrupt.state().error);
  corrupt.reset();
  assert.deepEqual(fs.readdirSync(join(dataDir, 'web')), []);
});

test('failed replacement and failed reset preserve the current TLS context and saved pair', (t) => {
  const { dataDir, certificates } = fixture(t);
  certificates.set({ domain, ...custom });
  const context = certificates.context(domain);
  const key = join(dataDir, 'web', 'key.pem');
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (to === key) throw new Error('test write failure');
    return rename(from, to);
  });
  assert.throws(() => certificates.set({ domain, ...renewed }), /当前服务证书未改变/);
  fault.mock.restore();
  const remove = fs.rmSync;
  t.mock.method(fs, 'rmSync', (path: fs.PathLike, options?: fs.RmOptions) => {
    if (path === key) throw new Error('test removal failure');
    return remove(path, options);
  });
  assert.throws(() => certificates.reset(), /当前服务证书未改变/);
  assert.equal(certificates.context(domain), context);
  assert.equal(fs.readFileSync(join(dataDir, 'web', 'cert.pem'), 'utf8'), custom.cert);
  assert.equal(fs.readFileSync(key, 'utf8'), custom.key);
  assert.deepEqual(fs.readdirSync(join(dataDir, 'web')).sort(), ['cert.pem', 'key.pem']);
});

test('reverse proxy and unencrypted listeners do not accept certificate imports', (t) => {
  const { dataDir } = fixture(t);
  for (const options of [{ reverseProxy: true }, {}]) {
    const certificates = new WebCertificates({ dataDir, domain, ...options });
    assert.equal(certificates.state().mode, options.reverseProxy ? 'external' : 'unavailable');
    assert.throws(() => certificates.set({ domain, ...custom }));
    assert.equal(fs.existsSync(join(dataDir, 'web')), false);
  }
});

test('SNI changes only new domain connections; IP/default TLS and existing connections keep their certificate', async (t) => {
  const { certificates } = fixture(t);
  const server = createServer({
    ...defaultCertificate,
    SNICallback: (name, done) => done(null, certificates.context(name)),
  });
  const sockets = new Set<ReturnType<typeof connect>>();
  server.on('secureConnection', (socket) => socket.on('data', (data) => socket.write(data)));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const open = (servername?: string) =>
    new Promise<ReturnType<typeof connect>>((resolve, reject) => {
      const socket = connect(
        { host: '127.0.0.1', port: address.port, servername, rejectUnauthorized: false },
        () => resolve(socket),
      );
      sockets.add(socket);
      socket.once('error', reject);
    });
  const fingerprint = (socket: ReturnType<typeof connect>) =>
    socket.getPeerCertificate().fingerprint256;
  const original = new X509Certificate(defaultCertificate.cert).fingerprint256;
  const existing = await open();
  assert.equal(fingerprint(existing), original);
  certificates.set({ domain, ...custom });
  assert.equal(fingerprint(await open(domain)), new X509Certificate(custom.cert).fingerprint256);
  assert.equal(fingerprint(await open()), original);
  assert.equal(fingerprint(await open('other.example.test')), original);
  certificates.reset();
  assert.equal(fingerprint(await open(domain)), original);
  existing.write('still connected');
  assert.equal(
    await new Promise<string>((resolve) =>
      existing.once('data', (data) => resolve(data.toString())),
    ),
    'still connected',
  );
});
