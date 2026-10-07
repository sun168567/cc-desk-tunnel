import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { rootCertificates } from 'node:tls';

const direct = process.env.PROXY_TLS_MODE !== 'reverse-proxy';
const request = (direct ? https : http).get(
  {
    host: '127.0.0.1',
    port: Number(process.env.PROXY_PORT ?? 8787),
    path: '/health',
    timeout: 3000,
    ...(direct
      ? {
          ca: [...rootCertificates, readFileSync(process.env.PROXY_TLS_CERT)],
          allowPartialTrustChain: true,
          servername: process.env.PROXY_CERT_NAME,
        }
      : {}),
  },
  (response) => {
    let body = '';
    response.on('data', (data) => {
      body += data;
    });
    response.on('end', () => {
      try {
        const status = JSON.parse(body);
        process.exit(
          response.statusCode === 200 && status.status === 'ok' && status.adapter === 'claude-code'
            ? 0
            : 1,
        );
      } catch {
        process.exit(1);
      }
    });
  },
);
request.on('timeout', () => request.destroy());
request.on('error', () => process.exit(1));
