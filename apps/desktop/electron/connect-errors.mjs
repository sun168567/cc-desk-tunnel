// What to tell the user when a connection fails: what went wrong, in the first line, and what to check, in the
// lines after it. The causes are told apart by what the operating system, the TLS layer and the components report.

const securityHint =
  '请查看杀毒软件 / Windows 安全中心的“保护历史记录”：核对文件来源后，可以还原被隔离的文件并只为它设置例外，再重新连接。详见项目主页的“杀毒软件与 SmartScreen”。';

// The control connection to `target` (host:port) failed with `error`; `proxy` is the system proxy it went through.
export function controlFailure(error, target, proxy) {
  const code = String(error?.code ?? '');
  const text = String(error?.message ?? '');
  const host = target.replace(/:\d+$/, '');
  const via = proxy
    ? `\n本次连接经系统代理 ${proxy.host}:${proxy.port} 发出，请一并确认代理可用。`
    : '';
  if (code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') return '会话历史超过 WebSocket 接收上限。';
  if (/\b429\b/.test(text)) return '登录失败次数过多，服务端已暂时拒绝本机，请稍后再试。';
  if (/^Proxy (refused|answer)/.test(text))
    return `系统代理${proxy ? ` ${proxy.host}:${proxy.port}` : ''}拒绝转发到 ${target} 的连接。\n请检查 Windows 的代理设置，或把服务地址加入代理的排除列表。`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    return `无法解析服务地址里的域名 ${host}。\n请检查地址是否拼写正确，以及本机网络与 DNS 是否正常。${via}`;
  if (code === 'ECONNREFUSED')
    return `${target} 拒绝了连接。\n服务端可能没有启动，或地址里的端口不是服务端的控制端口；经 nginx 反代时请确认 nginx 正在运行。${via}`;
  if (
    ['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL'].includes(code) ||
    /timed out/i.test(text)
  )
    return `连接 ${target} 超时。\n请检查服务器是否在线、服务器防火墙或云安全组是否放行了这个端口，以及本机网络是否能访问它。${via}`;
  if (code === 'CERT_HAS_EXPIRED')
    return '服务证书已过期。\n请在服务器上续期证书（部署脚本的 certificate 命令）后重新连接。';
  if (code === 'CERT_NOT_YET_VALID') return '服务证书尚未生效。\n请检查本机的系统时间是否正确。';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID')
    return `服务证书与地址里的主机名 ${host} 不符。\n请使用证书对应的域名连接，或在“服务证书指纹”里填入安装时给出的指纹。`;
  if (
    [
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    ].includes(code)
  )
    return '服务证书不是受信任的机构签发的。\n使用自签证书时，需要在“服务证书指纹”里填入安装时给出的 SHA256 指纹。';
  if (code === 'EPROTO' || code.startsWith('ERR_SSL_'))
    return `${target} 没有按 TLS 应答。\n地址应以 wss:// 开头并指向服务端的控制端口，请核对端口是否填对。${via}`;
  const status = /Unexpected server response: (\d+)/.exec(text)?.[1];
  if (status && ['502', '503', '504'].includes(status))
    return `${target} 的反向代理应答了 ${status}：它后面的服务端没有启动或无法访问。\n请在服务器上检查服务是否在运行。`;
  if (status)
    return `${target} 应答了 HTTP ${status}，不是本服务的连接入口。\n请核对服务地址；经 nginx 反代时检查是否转发了 WebSocket（Upgrade 请求头）。`;
  if (code === 'ECONNRESET' || code === 'EPIPE' || /socket hang up/.test(text))
    return `与 ${target} 的连接被中断。\n常见于该端口上不是本服务，或中间的网络设备切断了连接；请核对地址后重试。${via}`;
  return `无法连接 ${target}${code ? `（${code}）` : ''}。\n请检查服务地址和网络。${via}`;
}

// The Windows error codes with which the system, or security software through it, refuses to start a program.
const blocked = new Set(['2', '5', '225', '1260', '4551']);

// The component host ended while the connection was wanted. `output` is what it and its components printed,
// `tunnel` the service's tunnel endpoint (host:port), `early` whether this was while the connection was being set up.
export function componentFailure(output, tunnel, early) {
  const refused = /cc-desk-tunnel: cannot start (\S+) error (\d+)/.exec(output);
  if (refused) {
    const [, name, code] = refused;
    return blocked.has(code)
      ? `${name} 被 Windows 或安全软件拦截，无法启动（系统错误 ${code}）。\n${securityHint}`
      : `${name} 无法启动（系统错误 ${code}）。\n请重新安装本应用；仍然出现时检查安全软件的拦截记录。`;
  }
  const exited = /cc-desk-tunnel: (\S+) exited (\d+)/.exec(output);
  const name = exited?.[1] ?? '';
  const code = exited ? `（退出代码 ${exited[2]}）` : '';
  if (/^sshd/i.test(name))
    return `内置的 OpenSSH 服务（sshd.exe）已退出${code}。\n请重新连接；反复出现时检查安全软件是否拦截了它，或重新安装本应用。`;
  if (/^frpc/i.test(name)) {
    // frpc says why it gave up before it exits.
    if (/i\/o timeout|did not properly respond|timed out|deadline exceeded/i.test(output))
      return `连接服务器的隧道端口 ${tunnel} 超时。\n服务凭据已通过，但本机连不上隧道端口：请在服务器防火墙和云安全组里放行该端口（TCP），并确认它没有被本地网络屏蔽。`;
    if (/actively refused|connection refused/i.test(output))
      return `服务器的隧道端口 ${tunnel} 拒绝了连接。\n请确认对外开放的隧道端口与服务端配置的一致（端口映射、云安全组），然后重新连接。`;
    if (/no such host|lookup /i.test(output))
      return `无法解析隧道地址 ${tunnel}。\n这是服务端部署时填写的公网地址，请在服务器上核对它是否正确、能否从本机解析。`;
    if (/x509|certificate|tls:/i.test(output))
      return `隧道 ${tunnel} 的证书校验失败。\n隧道端口上应答的不是本服务，或服务端的公网地址、证书配置与实际不符；请在服务器上核对。`;
    if (/port already used|port not allowed|already exists|already in use/i.test(output))
      return '服务端为本次连接分配的端口不可用。\n请稍等几秒重新连接；反复出现时重启服务端。';
    if (/token|authoriz|authenticat/i.test(output))
      return '隧道认证没有通过。\n请重新连接；反复出现时确认隧道端口没有指向另一套部署。';
    return early
      ? `隧道组件 frpc.exe 启动后随即退出${code}。\n最常见的原因是它被杀毒软件或 Windows 安全中心拦截。${securityHint}\n如果没有拦截记录，再检查服务器防火墙 / 云安全组是否放行了隧道端口 ${tunnel}（TCP）。`
      : `隧道组件 frpc.exe 在连接建立后退出${code}。\n可能是被安全软件结束，或服务端重启、网络长时间中断；重新连接即可，反复出现时检查安全软件的保护记录。`;
  }
  return early
    ? `本机的隧道组件没能启动。\n常见原因是内置的 PowerShell、OpenSSH 或 frpc 被安全软件拦截。${securityHint}`
    : '本机的隧道组件已退出。\n请重新连接；反复出现时检查安全软件的保护记录。';
}

// A bundled program is not where it was installed, which is what a quarantine leaves behind.
export function missingComponent(name) {
  return `找不到随应用安装的 ${name}。\n它多半被杀毒软件或 Windows 安全中心隔离或删除了。${securityHint}\n没有隔离记录时请重新安装本应用。`;
}
