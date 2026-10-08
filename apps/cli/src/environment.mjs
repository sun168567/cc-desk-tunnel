// The proxy for a service address in the PAC form the bridge reads ("PROXY host:port" or "DIRECT"), taken from the
// usual https_proxy / all_proxy / no_proxy variables. Only plain HTTP proxies are used, as on the desktop.
export function environmentProxy(target, env = process.env) {
  const { hostname } = new URL(target);
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return 'DIRECT';
  for (const entry of (env.no_proxy ?? env.NO_PROXY ?? '').split(',')) {
    const name = entry
      .trim()
      .toLowerCase()
      .replace(/:\d+$/, '')
      .replace(/^\*?\./, '');
    if (name === '*' || (name && (host === name || host.endsWith(`.${name}`)))) return 'DIRECT';
  }
  const value = env.https_proxy || env.HTTPS_PROXY || env.all_proxy || env.ALL_PROXY;
  if (!value) return 'DIRECT';
  try {
    const proxy = new URL(value.includes('://') ? value : `http://${value}`);
    return proxy.protocol === 'http:' ? `PROXY ${proxy.hostname}:${proxy.port || 80}` : 'DIRECT';
  } catch {
    return 'DIRECT';
  }
}
