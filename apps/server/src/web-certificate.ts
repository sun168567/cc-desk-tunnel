import { createPrivateKey, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { createSecureContext, type SecureContext } from 'node:tls';
import { webDomainSchema } from '@cc-desk-tunnel/protocol';
import type { WebCertificateState } from '@cc-desk-tunnel/protocol';
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

const failure = (message: string) => new DomainError('web_certificate_invalid', message);
const selfSigned = (certificate: X509Certificate) =>
  certificate.checkIssued(certificate) && certificate.verify(certificate.publicKey);

function validate(domain: string, material: Material): Installed {
  const parsed = webDomainSchema.safeParse(domain);
  if (!parsed.success || !parsed.data) throw failure('请先在 Web 对外地址中填写域名。');
  const { cert, key } = material;
  if (cert.length > 64 * 1024 || key.length > 16 * 1024) {
    throw failure('证书链或私钥过长。');
  }
  const blocks = cert.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (
    !blocks?.length ||
    blocks.length > 16 ||
    cert.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()
  ) {
    throw failure('请提供 PEM 格式的证书链。');
  }
  if (
    !/^-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)-----\s+[A-Za-z0-9+/=\s]+-----END \1-----$/.test(
      key.trim(),
    )
  ) {
    throw failure('请提供未加密的 PEM 私钥。');
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
      throw failure('证书尚未生效或已过期。');
    }
    if (leaf.ca) throw failure('请将域名证书放在证书链第一项。');
    if (!leaf.checkHost(parsed.data, { subject: 'never' }))
      throw failure('证书不包含当前访问域名。');
    if (!leaf.checkPrivateKey(createPrivateKey(key))) throw failure('证书与私钥不匹配。');
    if (
      leaf.keyUsage &&
      !leaf.keyUsage.some((usage) => ['1.3.6.1.5.5.7.3.1', '2.5.29.37.0'].includes(usage))
    ) {
      throw failure('证书不允许用于 HTTPS 服务端。');
    }
    if (new Set(chain.map((entry) => entry.fingerprint256)).size !== chain.length) {
      throw failure('证书链包含重复证书。');
    }
    // Basic supplied-chain checks, not a PKIX trust-store, revocation or policy validator.
    for (let index = 0; index < chain.length - 1; index++) {
      const entry = chain[index]!;
      const issuer = chain[index + 1]!;
      if (!issuer.ca || !entry.checkIssued(issuer) || !entry.verify(issuer.publicKey)) {
        throw failure('证书链顺序或签名不正确。');
      }
    }
    const last = chain.at(-1)!;
    if (last.subject === last.issuer && !last.verify(last.publicKey)) {
      throw failure('证书签名不正确。');
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
    throw failure('证书或私钥格式无效。');
  }
}

// Only the domain's SNI context changes. The listener's original certificate is untouched.
export class WebCertificates {
  private directory: string;
  private mode: 'default' | 'external' | 'unavailable';
  private originalSelfSigned = false;
  private current?: Installed;
  private error?: string;

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
      this.error = '已保存的域名证书无效，请重新导入或恢复默认证书。';
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

  validateDomain(domain: string): void {
    if (this.current && domain.toLowerCase() !== this.current.details.domain) {
      throw new DomainError('web_certificate_domain', '请先恢复默认证书，再修改访问域名。');
    }
  }

  set({ domain, ...material }: Material & { domain: string }): void {
    if (this.mode !== 'default') {
      throw new DomainError(
        'web_certificate_unavailable',
        this.mode === 'external' ? '当前由反向代理管理 HTTPS 证书。' : '当前服务未配置 HTTPS。',
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
      throw new DomainError('web_certificate_save', '保存证书失败，当前服务证书未改变。');
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
