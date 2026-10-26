import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { Throttle } from './throttle.ts';
import { DomainError } from './errors.ts';

const lifetime = 5 * 60_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const invalid = () => new DomainError('passkey_expired', '本次验证已失效，请重新开始。');
export type PasskeyEntry = { rpId: string; origin: string };
type StoredKey = {
  id: string;
  credential_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string;
  rp_id: string;
  name: string;
  created: number;
  used: number | null;
};
type Challenge = PasskeyEntry & {
  id: string;
  challenge: string;
  expires: number;
  kind: 'register' | 'login' | 'proof';
  sessionId?: string;
  name?: string;
  address: string;
};

// A challenge may commit only while its original map entry survives. Expiry, logout and access
// changes remove it; verification consumes it once, after asynchronous cryptography and before writes.
export class Passkeys {
  private pending = new Throttle();
  private challenges = new Map<string, Challenge>();
  private proofs = new Map<string, { sessionId: string; expires: number }>();
  private db: DatabaseSync;
  private tokenHash: string;
  private userId: string;
  private now: () => number;
  constructor(db: DatabaseSync, tokenHash: string, userId: string, now = Date.now) {
    this.db = db;
    this.tokenHash = tokenHash;
    this.userId = userId;
    this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY, credential_id TEXT UNIQUE NOT NULL, public_key BLOB NOT NULL,
      counter INTEGER NOT NULL, transports TEXT NOT NULL, rp_id TEXT NOT NULL, token_hash TEXT NOT NULL,
      name TEXT NOT NULL, created INTEGER NOT NULL, used INTEGER
    )`);
    db.prepare('DELETE FROM passkeys WHERE token_hash != ?').run(tokenHash);
  }
  list(rpId: string) {
    return (
      this.db
        .prepare('SELECT id, rp_id, name, created, used FROM passkeys ORDER BY created DESC')
        .all() as Pick<StoredKey, 'id' | 'rp_id' | 'name' | 'created' | 'used'>[]
    ).map((row) => ({
      id: row.id,
      name: row.name,
      rpId: row.rp_id,
      createdAt: new Date(row.created).toISOString(),
      ...(row.used === null ? {} : { lastUsedAt: new Date(row.used).toISOString() }),
      available: row.rp_id === rpId,
    }));
  }
  private credentials(rpId: string) {
    return this.db
      .prepare('SELECT credential_id, transports FROM passkeys WHERE rp_id = ?')
      .all(rpId) as Pick<StoredKey, 'credential_id' | 'transports'>[];
  }
  rename(id: string, name: string) {
    if (!this.db.prepare('UPDATE passkeys SET name = ? WHERE id = ?').run(name, id).changes)
      throw new DomainError('passkey_missing', '通行密钥已被删除。');
  }
  remove(id: string) {
    this.db.prepare('DELETE FROM passkeys WHERE id = ?').run(id);
    // Invalidates in-flight logins as well as proofs issued by the removed key.
    this.clearPending();
  }
  clearPending() {
    for (const id of this.challenges.keys()) this.retire(id);
    this.proofs.clear();
  }
  revokeSession(sessionId: string) {
    for (const [id, value] of this.challenges) if (value.sessionId === sessionId) this.retire(id);
    for (const [id, value] of this.proofs)
      if (value.sessionId === sessionId) this.proofs.delete(id);
  }
  cancel(id: string, kind: Challenge['kind'], entry: PasskeyEntry, sessionId?: string) {
    const row = this.challenges.get(id);
    if (
      row?.kind === kind &&
      row.sessionId === sessionId &&
      row.rpId === entry.rpId &&
      row.origin === entry.origin
    )
      this.retire(id);
  }
  private retire(id: string) {
    const row = this.challenges.get(id);
    if (!row) return;
    this.challenges.delete(id);
    this.pending.leave(row.address);
  }
  private sweep() {
    for (const [id, value] of this.challenges) if (value.expires <= this.now()) this.retire(id);
    for (const [id, value] of this.proofs) if (value.expires <= this.now()) this.proofs.delete(id);
  }
  private challenge(
    kind: Challenge['kind'],
    entry: PasskeyEntry,
    address: string,
    sessionId?: string,
    name?: string,
    sessionExpires = Infinity,
  ) {
    this.sweep();
    if (!this.pending.enter(address))
      throw new DomainError('passkey_busy', '等待验证的请求过多，请稍后重试。');
    const row: Challenge = {
      ...entry,
      id: randomUUID(),
      challenge: randomBytes(32).toString('base64url'),
      expires: Math.min(this.now() + lifetime, sessionExpires),
      kind,
      sessionId,
      name,
      address,
    };
    this.challenges.set(row.id, row);
    return row;
  }
  private current(row: Challenge) {
    if (this.challenges.get(row.id) !== row || row.expires <= this.now()) throw invalid();
  }
  private read(id: string, kind: Challenge['kind'], entry: PasskeyEntry, sessionId?: string) {
    this.sweep();
    const row = this.challenges.get(id);
    if (
      !row ||
      row.kind !== kind ||
      row.sessionId !== sessionId ||
      row.rpId !== entry.rpId ||
      row.origin !== entry.origin
    )
      throw invalid();
    return row;
  }
  async registrationOptions(
    name: string,
    sessionId: string,
    entry: PasskeyEntry,
    address: string,
    sessionExpires = Infinity,
  ) {
    const row = this.challenge('register', entry, address, sessionId, name, sessionExpires);
    try {
      this.keyLimit();
      const options = await generateRegistrationOptions({
        rpName: 'CC Desk Tunnel',
        rpID: entry.rpId,
        userID: new TextEncoder().encode(this.userId),
        userName: '工作台',
        challenge: Buffer.from(row.challenge, 'base64url'),
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
        excludeCredentials: this.credentials(entry.rpId).map((key) => ({
          id: key.credential_id,
          transports: JSON.parse(key.transports) as string[],
        })),
      });
      this.current(row);
      return { challengeId: row.id, options, name, expiresAt: new Date(row.expires).toISOString() };
    } catch (error) {
      this.retire(row.id);
      throw error;
    }
  }
  private keyLimit() {
    const { count } = this.db.prepare('SELECT COUNT(*) AS count FROM passkeys').get() as {
      count: number;
    };
    if (count >= 32)
      throw new DomainError('passkey_limit', '通行密钥已达上限，请先删除不用的密钥。');
  }
  async register(
    id: string,
    response: RegistrationResponseJSON,
    entry: PasskeyEntry,
    sessionId: string,
  ) {
    const row = this.read(id, 'register', entry, sessionId);
    try {
      const result = await verifyRegistrationResponse({
        response,
        expectedChallenge: row.challenge,
        expectedOrigin: entry.origin,
        expectedRPID: entry.rpId,
        requireUserVerification: false,
      });
      this.current(row);
      this.retire(id);
      if (!result.verified || !result.registrationInfo) throw invalid();
      this.keyLimit();
      const key = result.registrationInfo.credential;
      if (this.db.prepare('SELECT id FROM passkeys WHERE credential_id = ?').get(key.id))
        throw new DomainError('passkey_duplicate', '这份通行密钥已经添加。');
      const passkeyId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO passkeys
        (id,credential_id,public_key,counter,transports,rp_id,token_hash,name,created)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          passkeyId,
          key.id,
          key.publicKey,
          key.counter,
          JSON.stringify(key.transports ?? []),
          entry.rpId,
          this.tokenHash,
          row.name!,
          this.now(),
        );
      return passkeyId;
    } finally {
      this.retire(id);
    }
  }
  async authenticationOptions(
    kind: 'login' | 'proof',
    entry: PasskeyEntry,
    address: string,
    sessionId?: string,
    sessionExpires = Infinity,
  ) {
    if (!this.credentials(entry.rpId).length)
      throw new DomainError('passkey_missing', '此域名尚未设置通行密钥。');
    const row = this.challenge(kind, entry, address, sessionId, undefined, sessionExpires);
    try {
      const options = await generateAuthenticationOptions({
        rpID: entry.rpId,
        userVerification: 'preferred',
        challenge: Buffer.from(row.challenge, 'base64url'),
      });
      this.current(row);
      return { challengeId: row.id, options, expiresAt: new Date(row.expires).toISOString() };
    } catch (error) {
      this.retire(row.id);
      throw error;
    }
  }
  async authenticate<T>(
    kind: 'login' | 'proof',
    id: string,
    response: AuthenticationResponseJSON,
    entry: PasskeyEntry,
    sessionId: string | undefined,
    commit: (id: string) => T,
  ) {
    const challenge = this.read(id, kind, entry, sessionId);
    try {
      if (
        response.response.userHandle &&
        response.response.userHandle !== Buffer.from(this.userId).toString('base64url')
      )
        throw invalid();
      const row = this.db
        .prepare('SELECT * FROM passkeys WHERE credential_id = ? AND rp_id = ?')
        .get(response.id, entry.rpId) as StoredKey | undefined;
      if (!row) throw invalid();
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: entry.origin,
        expectedRPID: entry.rpId,
        requireUserVerification: false,
        credential: {
          id: row.credential_id,
          publicKey: new Uint8Array(row.public_key),
          counter: row.counter,
          transports: JSON.parse(row.transports) as string[],
        },
      });
      this.current(challenge);
      this.retire(id);
      if (
        !result.verified ||
        !this.db
          .prepare('UPDATE passkeys SET counter = ?, used = ? WHERE id = ? AND counter = ?')
          .run(result.authenticationInfo.newCounter, this.now(), row.id, row.counter).changes
      )
        throw invalid();
      // Session/proof creation stays in this synchronous commit; returning an id first would leave
      // another promise boundary in which revocation could be followed by a new login.
      return commit(row.id);
    } finally {
      this.retire(id);
    }
  }
  proof(sessionId: string) {
    this.sweep();
    if (this.proofs.size >= 128)
      throw new DomainError('passkey_busy', '等待验证的请求过多，请稍后重试。');
    const secret = randomBytes(32).toString('base64url');
    const expires = this.now() + 60_000;
    this.proofs.set(hash(secret), { sessionId, expires });
    return { proof: secret, expiresAt: new Date(expires).toISOString() };
  }
  consumeProof(secret: string, sessionId: string) {
    this.sweep();
    const key = hash(secret),
      value = this.proofs.get(key);
    if (!value || value.sessionId !== sessionId) throw invalid();
    this.proofs.delete(key);
  }
}
