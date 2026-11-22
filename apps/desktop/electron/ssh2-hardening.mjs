import { createRequire } from 'node:module';

// Hardens ssh2 1.17.0 where it serves SSH: the device's SSH service on macOS and Linux. The same is done for the
// service's file panel in apps/server/src/ssh2-hardening.ts; keep the two alike.
//
// Before anyone signs in, ssh2 takes a `hostkeys-00@openssh.com` global request, a message servers send to
// clients, and reads every string in it as a key with regular expressions that slow down quadratically on
// crafted text (CVE-2025-70034 names this version). Its `zlib` compression, which starts before sign-in, lets
// one small packet carry a large such text. A few hundred bytes from anything that can reach the loopback port
// would stop the service for seconds, more for hours. So the request is dropped unread, and compression is off.
const require = createRequire(import.meta.url);
const { version } = require('ssh2/package.json');
if (version !== '1.17.0') throw new Error('ssh2 hardening requires review for ssh2 upgrades.');
// Source: https://github.com/mscdex/ssh2/blob/v1.17.0/lib/protocol/handlers.js
const handlers = require('ssh2/lib/protocol/handlers.js');
const GLOBAL_REQUEST = 80;
const original = handlers[GLOBAL_REQUEST];
const HOSTKEYS = 'hostkeys-00@openssh.com';
if (typeof original !== 'function') throw new Error('ssh2 hardening: unexpected ssh2 internals.');
if (!original.hardened) {
  const handler = (self, payload) => {
    // byte SSH_MSG_GLOBAL_REQUEST, string request name, ...: a malformed one goes to ssh2, which refuses it.
    if (payload.length >= 5) {
      const length = payload.readUInt32BE(1);
      if (length === HOSTKEYS.length && payload.toString('latin1', 5, 5 + length) === HOSTKEYS)
        return;
    }
    return original(self, payload);
  };
  handler.hardened = true;
  handlers[GLOBAL_REQUEST] = handler;
}

// For `new Server({ algorithms })`: no compression, so a packet's size bounds what it carries.
export const serverAlgorithms = { compress: ['none'] };
