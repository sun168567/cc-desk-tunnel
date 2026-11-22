import { createRequire } from 'node:module';

// Hardens ssh2 1.17.0 where it serves SSH: the file panel's connections, which come in only with a tunnel
// secret but are served in the service's own process. The same is done for the device's SSH service in
// apps/desktop/electron/ssh2-hardening.mjs; keep the two alike.
//
// Before anyone signs in, ssh2 takes a `hostkeys-00@openssh.com` global request, a message servers send to
// clients, and reads every string in it as a key with regular expressions that slow down quadratically on
// crafted text (CVE-2025-70034 names this version). Its `zlib` compression, which starts before sign-in, lets
// one small packet carry a large such text. So the request is dropped unread, and compression is off.
const require = createRequire(import.meta.url);
const { version } = require('ssh2/package.json') as { version: string };
if (version !== '1.17.0') throw new Error('ssh2 hardening requires review for ssh2 upgrades.');
// Source: https://github.com/mscdex/ssh2/blob/v1.17.0/lib/protocol/handlers.js
type Handler = ((self: unknown, payload: Buffer) => unknown) & { hardened?: boolean };
const handlers = require('ssh2/lib/protocol/handlers.js') as Handler[];
const GLOBAL_REQUEST = 80;
const original = handlers[GLOBAL_REQUEST];
const HOSTKEYS = 'hostkeys-00@openssh.com';
if (typeof original !== 'function') throw new Error('ssh2 hardening: unexpected ssh2 internals.');
if (!original.hardened) {
  const handler: Handler = (self, payload) => {
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

// For `new ssh2.Server({ algorithms })`: no compression, so a packet's size bounds what it carries.
export const serverAlgorithms: { compress: 'none'[] } = { compress: ['none'] };
