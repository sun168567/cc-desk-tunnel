import { createPrivateKey, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { createSecureContext, type SecureContext } from 'node:tls';
import { webDomainSchema } from '@cc-desk-tunnel/protocol';
import type { WebCertificateState } from '@cc-desk-tunnel/protocol';
import { phrase, type Words } from '@cc-desk-tunnel/i18n';
import { DomainError } from './errors.ts';

type Material = { cert: string; key: string };
type Installed = Material & {
  context: SecureContext;
  details: NonNullable<WebCertificateState['details']>;
};
type Options = {
  dataDir: string;
  domain: string;
  tls?: { cert: string | Buffer; key: string | Buffer };
  reverseProxy?: boolean;
};

const failure = (words: Words) => new DomainError('web_certificate_invalid', words);
const selfSigned = (certificate: X509Certificate) =>
  certificate.checkIssued(certificate) && certificate.verify(certificate.publicKey);

function validate(domain: string, material: Material): Installed {
  const parsed = webDomainSchema.safeParse(domain);
  if (!parsed.success || !parsed.data) throw failure(phrase('service:certificate.noDomain'));
  const { cert, key } = material;
  if (cert.length > 64 * 1024 || key.length > 16 * 1024) {
    throw failure(phrase('service:certificate.tooLong'));
  }
  const blocks = cert.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (
    !blocks?.length ||
    blocks.length > 16 ||
    cert.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()
  ) {
    throw failure(phrase('service:certificate.chainFormat'));
  }
  if (
    !/^-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)-----\s+[A-Za-z0-9+/=\s]+-----END \1-----$/.test(
      key.trim(),
    )
  ) {
    throw failure(phrase('service:certificate.keyFormat'));
  }
  try {
    const chain = blocks.map((block) => new X509Certificate(block));
    const leaf = chain[0]!;
    const now = Date.now();
    if (
      chain.some(
        (entry) => now < entry.validFromDate.getTime() || now >= entry.validToDate.getTime(),
      )
    ) {
      throw failure(phrase('service:certificate.notValidNow'));
    }
    if (leaf.ca) throw failure(phrase('service:certificate.leafFirst'));
    if (!leaf.checkHost(parsed.data, { subject: 'never' }))
      throw failure(phrase('service:certificate.wrongDomain'));
    if (!leaf.checkPrivateKey(createPrivateKey(key)))
      throw failure(phrase('service:certificate.keyMismatch'));
    if (
      leaf.keyUsage &&
      !leaf.keyUsage.some((usage) => ['1.3.6.1.5.5.7.3.1', '2.5.29.37.0'].includes(usage))
    ) {
      throw failure(phrase('service:certificate.notForServer'));
    }
    if (new Set(chain.map((entry) => entry.fingerprint256)).size !== chain.length) {
      throw failure(phrase('service:certificate.duplicate'));
    }
    // Basic supplied-chain checks, not a PKIX trust-store, revocation or policy validator.
    for (let index = 0; index < chain.length - 1; index++) {
      const entry = chain[index]!;
      const issuer = chain[index + 1]!;
      if (!issuer.ca || !entry.checkIssued(issuer) || !entry.verify(issuer.publicKey)) {
        throw failure(phrase('service:certificate.chainOrder'));
      }
    }
    const last = chain.at(-1)!;
    if (last.subject === last.issuer && !last.verify(last.publicKey)) {
      throw failure(phrase('service:certificate.signature'));
    }
    return {
      cert,
      key,
      context: createSecureContext({ cert, key }),
      details: {
        domain: parsed.data,
        issuer: leaf.issuer,
        validFrom: leaf.validFromDate.toISOString(),
        validTo: leaf.validToDate.toISOString(),
        fingerprint: leaf.fingerprint256,
        selfSigned: selfSigned(leaf),
      },
    };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw failure(phrase('service:certificate.invalid'));
  }
}

// Only the domain's SNI context changes. The listener's original certificate is untouched.
export class WebCertificates {
  private directory: string;
  private mode: 'default' | 'external' | 'unavailable';
  private originalSelfSigned = false;
  private current?: Installed;
  private error?: Words;

  constructor(options: Options) {
    this.directory = join(options.dataDir, 'web');
    this.mode = options.reverseProxy ? 'external' : options.tls ? 'default' : 'unavailable';
    if (options.tls) {
      try {
        this.originalSelfSigned = selfSigned(new X509Certificate(options.tls.cert));
      } catch {
        /* The listener validates its own TLS configuration. */
      }
    }
    if (this.mode !== 'default') return;
    const certificate = join(this.directory, 'cert.pem');
    const key = join(this.directory, 'key.pem');
    if (!fs.existsSync(certificate) && !fs.existsSync(key)) return;
    try {
      this.current = validate(options.domain, {
        cert: fs.readFileSync(certificate, 'utf8'),
        key: fs.readFileSync(key, 'utf8'),
      });
      fs.chmodSync(certificate, 0o600);
      fs.chmodSync(key, 0o600);
    } catch {
      this.current = undefined;
      this.error = phrase('service:certificate.savedInvalid');
    }
  }

  state(): WebCertificateState {
    return {
      mode: this.current ? 'custom' : this.mode,
      selfSigned: this.current?.details.selfSigned ?? this.originalSelfSigned,
      ...(this.current ? { details: { ...this.current.details } } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  context(servername: string): SecureContext | undefined {
    return servername.toLowerCase() === this.current?.details.domain
      ? this.current.context
      : undefined;
  }

  selfSigned(servername?: string): boolean {
    return servername && this.context(servername)
      ? this.current!.details.selfSigned
      : this.originalSelfSigned;
  }

  validateDomain(domain: string): void {
    if (this.current && domain.toLowerCase() !== this.current.details.domain) {
      throw new DomainError('web_certificate_domain', phrase('service:certificate.restoreFirst'));
    }
  }

  set({ domain, ...material }: Material & { domain: string }): void {
    if (this.mode !== 'default') {
      throw new DomainError(
        'web_certificate_unavailable',
        phrase(
          this.mode === 'external' ? 'service:certificate.byProxy' : 'service:certificate.noHttps',
        ),
      );
    }
    const next = validate(domain, material);
    this.save(material);
    this.current = next;
    this.error = undefined;
  }

  reset(): void {
    this.save(undefined);
    this.current = undefined;
    this.error = undefined;
  }

  private save(material: Material | undefined): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const files = ['cert.pem', 'key.pem'].map((name) => join(this.directory, name));
    const before = files.map((file) => (fs.existsSync(file) ? fs.readFileSync(file) : undefined));
    const temporary = files.map((file) => `${file}.tmp`);
    try {
      if (material) {
        for (const [index, content] of [material.cert, material.key].entries()) {
          fs.writeFileSync(temporary[index]!, content, { mode: 0o600, flag: 'wx' });
        }
        for (const [index, file] of files.entries()) fs.renameSync(temporary[index]!, file);
      } else {
        for (const file of files) fs.rmSync(file, { force: true });
      }
    } catch {
      // A failed second write/removal must not replace the currently serving pair.
      for (const [index, file] of files.entries()) {
        try {
          if (before[index]) fs.writeFileSync(file, before[index], { mode: 0o600 });
          else fs.rmSync(file, { force: true });
        } catch {
          /* Keep the active TLS context even when storage is no longer writable. */
        }
      }
      throw new DomainError('web_certificate_save', phrase('service:certificate.saveFailed'));
    } finally {
      for (const file of temporary) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          /* Report the original storage error. */
        }
      }
    }
  }
}
