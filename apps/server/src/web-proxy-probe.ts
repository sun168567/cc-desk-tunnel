import { randomBytes, timingSafeEqual } from 'node:crypto';
import { request } from 'node:https';
import { DomainError } from './errors.ts';

type Pending = {
  owner: string;
  challenge?: string;
  address?: string;
  cancel: (message?: string) => void;
};
const failure = (message: string) => new DomainError('web_proxy_detection_failed', message);

// A round trip to the saved public entry identifies a candidate, not a trusted proxy. Only the
// authenticated desktop receives the observed socket address; no request changes the trust list.
export class WebProxyProbe {
  private pending?: Pending;

  async detect(url: URL, owner: string): Promise<string> {
    if (this.pending) throw failure('正在检测反向代理，请等待当前检测结束后重试。');
    const controller = new AbortController();
    const pending: Pending = {
      owner,
      challenge: randomBytes(32).toString('hex'),
      cancel: (message = '检测已取消，请确认当前设置后重试。') => {
        pending.challenge = undefined;
        pending.address = undefined;
        controller.abort(failure(message));
      },
    };
    this.pending = pending;
    const timer = setTimeout(
      () => pending.cancel('检测超时，请检查 Web 对外地址是否可从服务器访问。'),
      8000,
    );
    try {
      return await new Promise<string>((resolve, reject) => {
        const outgoing = request(
          url,
          {
            method: 'GET',
            agent: false,
            rejectUnauthorized: true,
            signal: controller.signal,
            headers: { 'X-CC-Proxy-Probe': pending.challenge! },
          },
          (response) => {
            response.destroy();
            if (controller.signal.aborted) {
              reject(controller.signal.reason);
            } else if (response.statusCode! >= 300 && response.statusCode! < 400) {
              reject(failure('Web 对外地址发生跳转，请填写最终 HTTPS 地址后重试。'));
            } else if (response.statusCode === 204 && pending.address) {
              resolve(pending.address);
            } else {
              reject(failure('未检测到有效反向代理，请检查 Web 对外地址和代理的 X-Real-IP 配置。'));
            }
          },
        );
        outgoing.on('error', (error: NodeJS.ErrnoException) => {
          if (controller.signal.aborted) return reject(controller.signal.reason);
          const certificateError = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(
            error.code ?? '',
          );
          reject(
            failure(
              certificateError
                ? 'Web 对外地址的 HTTPS 证书验证失败，请检查证书后重试。'
                : '连接 Web 对外地址失败，请检查地址和网络后重试。',
            ),
          );
        });
        outgoing.end();
      });
    } finally {
      clearTimeout(timer);
      if (this.pending === pending) this.pending = undefined;
    }
  }

  observe(challenge: string | string[] | undefined, address: string) {
    const pending = this.pending;
    if (
      !pending?.challenge ||
      typeof challenge !== 'string' ||
      !/^[a-f0-9]{64}$/.test(challenge) ||
      !timingSafeEqual(Buffer.from(challenge, 'hex'), Buffer.from(pending.challenge, 'hex'))
    )
      return false;
    pending.challenge = undefined;
    pending.address = address;
    return true;
  }

  cancel(owner?: string) {
    if (owner === undefined || this.pending?.owner === owner) this.pending?.cancel();
  }
}
