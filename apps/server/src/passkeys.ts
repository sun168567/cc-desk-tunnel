import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { DomainError } from './errors.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const lifetime = 5 * 60_000;
const invalid = () => new DomainError('passkey_expired', '本次验证已失效，请重新开始。');
export type PasskeyEntry = { rpId: string; origin: string; url: string };
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
type Registration = PasskeyEntry & {
  id: string;
  grantHash: string;
  owner: string;
  name: string;
  expires: number;
  status: 'pending' | 'complete';
  passkeyId?: string;
  revision?: number;
};
type Challenge = PasskeyEntry & {
  challenge: string;
  expires: number;
  kind: 'register' | 'login' | 'proof';
  registrationId?: string;
  sessionId?: string;
};

// WebAuthn owns public keys and short-lived ceremonies, never browser session secrets.
// Pending authorizations are bounded and intentionally lost on restart, logout or an entry change.
export class Passkeys {
  private db: DatabaseSync;
  private tokenHash: string;
  private userId: string;
  private now: () => number;
  private epoch = 0;
  private registrations = new Map<string, Registration>();
  private challenges = new Map<string, Challenge>();
  private proofs = new Map<string, { sessionId: string; passkeyId: string; expires: number }>();
  private issuance = new Map<string, { count: number; expires: number }>();
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
      this.db.prepare('SELECT * FROM passkeys ORDER BY created DESC').all() as StoredKey[]
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
    return this.db.prepare('SELECT * FROM passkeys WHERE rp_id = ?').all(rpId) as StoredKey[];
  }
  exists(id: string, rpId?: string) {
    const row = this.db.prepare('SELECT rp_id FROM passkeys WHERE id = ?').get(id) as
      { rp_id: string } | undefined;
    return !!row && (rpId === undefined || row.rp_id === rpId);
  }
  rename(id: string, name: string) {
    if (!this.db.prepare('UPDATE passkeys SET name = ? WHERE id = ?').run(name, id).changes)
      throw new DomainError('passkey_missing', '通行密钥已被删除。');
  }
  remove(id: string) {
    this.db.prepare('DELETE FROM passkeys WHERE id = ?').run(id);
    for (const [key, proof] of this.proofs) if (proof.passkeyId === id) this.proofs.delete(key);
  }
  clearPending() {
    this.epoch++;
    this.registrations.clear();
    this.challenges.clear();
    this.proofs.clear();
  }
  revokeOwner(owner: string) {
    for (const [id, value] of this.registrations)
      if (value.owner === owner) this.registrations.delete(id);
    for (const [id, value] of this.challenges)
      if (
        value.sessionId === owner ||
        (value.registrationId && !this.registrations.has(value.registrationId))
      )
        this.challenges.delete(id);
    for (const [id, value] of this.proofs) if (value.sessionId === owner) this.proofs.delete(id);
  }
  private sweep() {
    const now = this.now();
    for (const collection of [this.registrations, this.challenges, this.proofs, this.issuance])
      for (const [id, value] of collection) if (value.expires <= now) collection.delete(id);
  }
  // Serial requests also cost a place: one address cannot fill all five-minute ceremony maps.
  // Verification, polling and cancellation use no issuance budget, so an existing flow can finish.
  issue(address: string) {
    this.sweep();
    const record = this.issuance.get(address);
    if (record && record.count >= 12) return Math.ceil((record.expires - this.now()) / 1000);
    if (!record && this.issuance.size >= 1024) return Math.ceil(lifetime / 1000);
    if (record) record.count++;
    else this.issuance.set(address, { count: 1, expires: this.now() + lifetime });
    return 0;
  }
  private room(collection: Map<string, unknown>, limit = 128) {
    this.sweep();
    if (collection.size >= limit)
      throw new DomainError('passkey_busy', '等待验证的请求过多，请稍后重试。');
  }
  start(name: string, owner: string, entry: PasskeyEntry, sessionExpires = Infinity) {
    this.room(this.registrations, 64);
    if (this.list(entry.rpId).length >= 32)
      throw new DomainError('passkey_limit', '通行密钥已达上限，请先删除不用的密钥。');
    const grant = randomBytes(32).toString('base64url');
    const registration: Registration = {
      ...entry,
      id: randomUUID(),
      grantHash: hash(grant),
      owner,
      name,
      expires: Math.min(this.now() + lifetime, sessionExpires),
      status: 'pending',
    };
    this.registrations.set(registration.id, registration);
    return {
      ...this.status(registration.id, owner),
      url: `${entry.url}#passkey-register=${grant}`,
    };
  }
  status(id: string, owner: string) {
    this.sweep();
    const row = this.registrations.get(id);
    if (!row || row.owner !== owner) return { registrationId: id, status: 'expired' as const };
    return {
      registrationId: id,
      status: row.status,
      expiresAt: new Date(row.expires).toISOString(),
      ...(row.passkeyId ? { passkeyId: row.passkeyId } : {}),
    };
  }
  cancel(id: string, owner: string) {
    if (this.registrations.get(id)?.owner === owner) this.registrations.delete(id);
  }
  async registrationOptions(grant: string, entry: PasskeyEntry) {
    this.sweep();
    const row = [...this.registrations.values()].find((value) => value.grantHash === hash(grant));
    if (!row || row.status !== 'pending' || row.origin !== entry.origin || row.rpId !== entry.rpId)
      throw invalid();
    // A cancelled system prompt can retry; only the latest ceremony for the link may finish.
    const revision = (row.revision = (row.revision ?? 0) + 1);
    for (const [id, value] of this.challenges)
      if (value.registrationId === row.id) this.challenges.delete(id);
    this.room(this.challenges);
    const options = await generateRegistrationOptions({
      rpName: 'CC Desk Tunnel',
      rpID: entry.rpId,
      userID: new TextEncoder().encode(this.userId),
      userName: '工作台',
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: this.credentials(entry.rpId).map((key) => ({
        id: key.credential_id,
        transports: JSON.parse(key.transports) as AuthenticatorTransport[],
      })),
    });
    this.room(this.challenges);
    if (
      this.registrations.get(row.id) !== row ||
      row.expires <= this.now() ||
      row.revision !== revision
    )
      throw invalid();
    const challengeId = randomUUID();
    this.challenges.set(challengeId, {
      ...entry,
      challenge: options.challenge,
      expires: row.expires,
      kind: 'register',
      registrationId: row.id,
    });
    return { challengeId, options, name: row.name, expiresAt: new Date(row.expires).toISOString() };
  }
  private take(id: string, kind: Challenge['kind'], entry: PasskeyEntry, sessionId?: string) {
    this.sweep();
    const row = this.challenges.get(id);
    if (
      !row ||
      row.kind !== kind ||
      row.origin !== entry.origin ||
      row.rpId !== entry.rpId ||
      row.sessionId !== sessionId
    )
      throw invalid();
    // Consume before asynchronous cryptography, so concurrent replies cannot reuse a challenge.
    this.challenges.delete(id);
    return row;
  }
  async register(id: string, response: RegistrationResponseJSON, entry: PasskeyEntry) {
    const challenge = this.take(id, 'register', entry);
    const row = this.registrations.get(challenge.registrationId!);
    if (!row || row.status !== 'pending') throw invalid();
    const revision = row.revision;
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: entry.origin,
      expectedRPID: entry.rpId,
      requireUserVerification: true,
    });
    if (
      !result.verified ||
      !result.registrationInfo ||
      this.registrations.get(row.id) !== row ||
      row.expires <= this.now() ||
      row.revision !== revision
    )
      throw invalid();
    if (this.list(entry.rpId).length >= 32)
      throw new DomainError('passkey_limit', '通行密钥已达上限，请先删除不用的密钥。');
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
        row.name,
        this.now(),
      );
    row.status = 'complete';
    row.passkeyId = passkeyId;
    return passkeyId;
  }
  async authenticationOptions(kind: 'login' | 'proof', entry: PasskeyEntry, sessionId?: string) {
    this.room(this.challenges);
    const epoch = this.epoch;
    const keys = this.credentials(entry.rpId);
    if (!keys.length) throw new DomainError('passkey_missing', '此域名尚未设置通行密钥。');
    const options = await generateAuthenticationOptions({
      rpID: entry.rpId,
      userVerification: 'required',
    });
    this.room(this.challenges);
    const challengeId = randomUUID();
    if (epoch !== this.epoch) throw invalid();
    this.challenges.set(challengeId, {
      ...entry,
      challenge: options.challenge,
      expires: this.now() + lifetime,
      kind,
      sessionId,
    });
    return { challengeId, options };
  }
  async authenticate(
    kind: 'login' | 'proof',
    id: string,
    response: AuthenticationResponseJSON,
    entry: PasskeyEntry,
    sessionId?: string,
  ) {
    const epoch = this.epoch;
    const challenge = this.take(id, kind, entry, sessionId);
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
      requireUserVerification: true,
      credential: {
        id: row.credential_id,
        publicKey: new Uint8Array(row.public_key),
        counter: row.counter,
        transports: JSON.parse(row.transports) as AuthenticatorTransport[],
      },
    });
    if (!result.verified || challenge.expires <= this.now() || epoch !== this.epoch)
      throw invalid();
    if (
      !this.db
        .prepare('UPDATE passkeys SET counter = ?, used = ? WHERE id = ? AND counter = ?')
        .run(result.authenticationInfo.newCounter, this.now(), row.id, row.counter).changes
    )
      throw invalid();
    return row.id;
  }
  proof(sessionId: string, passkeyId: string) {
    this.room(this.proofs);
    const secret = randomBytes(32).toString('base64url');
    this.proofs.set(hash(secret), { sessionId, passkeyId, expires: this.now() + 60_000 });
    return secret;
  }
  consumeProof(secret: string, sessionId: string) {
    this.sweep();
    const key = hash(secret);
    const proof = this.proofs.get(key);
    if (!proof || proof.sessionId !== sessionId || !this.exists(proof.passkeyId)) throw invalid();
    this.proofs.delete(key);
  }
}
