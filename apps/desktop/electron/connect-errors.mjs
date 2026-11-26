// What to tell the user when a connection fails: what went wrong, in the first line, and what to check, in the
// lines after it. The causes are told apart by what the operating system, the TLS layer and the components report.
// Each is a phrase (failure.cjs), said in the window's language where it is shown: `desktop:connect.lines` puts
// what went wrong (`what`) over what to check (`check`).
import { phrase } from './failure.cjs';

const lines = (what, check) => phrase('desktop:connect.lines', { what, check });
const securityHint = phrase('desktop:component.security');

// Whether a failed connection is the kind that a later attempt may get past: the way to the service was not
// there or broke. A certificate that is not the service's, or an address that is something else, is not.
export function passing(error) {
  const code = String(error?.code ?? '');
  const text = String(error?.message ?? '');
  return (
    [
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'ECONNRESET',
      'ECONNABORTED',
      'EPIPE',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'EHOSTDOWN',
      'ENETUNREACH',
      'ENETDOWN',
      'EADDRNOTAVAIL',
    ].includes(code) ||
    /timed out|socket hang up|^Proxy (refused|answer)|Unexpected server response: 50[234]/i.test(
      text,
    )
  );
}
// The control connection to `target` (host:port) failed with `error`; `proxy` is the system proxy it went through.
export function controlFailure(error, target, proxy) {
  const code = String(error?.code ?? '');
  const text = String(error?.message ?? '');
  const host = target.replace(/:\d+$/, '');
  const via = proxy ? phrase('desktop:connect.via', { proxy: `${proxy.host}:${proxy.port}` }) : '';
  const failed = (name, values = {}) =>
    lines(
      phrase(`desktop:connect.${name}.what`, { target, host, ...values }),
      phrase(`desktop:connect.${name}.check`, { via }),
    );
  if (code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') return phrase('desktop:connect.tooLong');
  if (/\b429\b/.test(text)) return phrase('desktop:connect.tooMany');
  if (/^Proxy (refused|answer)/.test(text))
    return lines(
      proxy
        ? phrase('desktop:connect.proxyRefused.whatNamed', {
            proxy: `${proxy.host}:${proxy.port}`,
            target,
          })
        : phrase('desktop:connect.proxyRefused.what', { target }),
      phrase('desktop:connect.proxyRefused.check'),
    );
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return failed('unresolved');
  if (code === 'ECONNREFUSED') return failed('refused');
  if (
    ['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL'].includes(code) ||
    /timed out/i.test(text)
  )
    return failed('timeout');
  if (code === 'CERT_HAS_EXPIRED') return failed('expired');
  if (code === 'CERT_NOT_YET_VALID') return failed('notYetValid');
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return failed('hostMismatch');
  if (
    [
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    ].includes(code)
  )
    return failed('untrusted');
  if (code === 'EPROTO' || code.startsWith('ERR_SSL_')) return failed('notTls');
  const status = /Unexpected server response: (\d+)/.exec(text)?.[1];
  if (status && ['502', '503', '504'].includes(status)) return failed('gateway', { status });
  if (status) return failed('http', { status });
  if (code === 'ECONNRESET' || code === 'EPIPE' || /socket hang up/.test(text))
    return failed('reset');
  return code ? failed('otherCode', { code }) : failed('other');
}

// The Windows error codes with which the system, or security software through it, refuses to start a program.
const blocked = new Set(['2', '5', '225', '1260', '4551']);

// The execution channel did not get ready within `seconds`, although the service accepted the sign-in and the
// local SSH service started. `error` is why the last channel connection to `target` could not be opened, if
// that is what stood in the way; `proxy` the system proxy in use.
export function channelFailure(seconds, error, target, proxy) {
  if (error) {
    const cause = controlFailure(error, target, proxy);
    // What went wrong with it, without what to check for a control connection.
    return phrase('desktop:channel.failed', { seconds, cause: cause.params?.what ?? cause });
  }
  // Elsewhere the user's own shell runs the probe, whose startup scripts may take long.
  return phrase('desktop:channel.noAnswer', {
    seconds,
    slow: phrase(
      process.platform === 'win32' ? 'desktop:channel.slow' : 'desktop:channel.slowShell',
    ),
  });
}

// The component host ended while the connection was wanted. `output` is what it and its components printed,
// `early` whether this was while the connection was being set up.
export function componentFailure(output, early) {
  const refused = /cc-desk-tunnel: cannot start (\S+) error (\d+)/.exec(output);
  if (refused) {
    const [, name, code] = refused;
    return blocked.has(code)
      ? phrase('desktop:component.blocked', { name, code, hint: securityHint })
      : phrase('desktop:component.cannotStart', { name, code });
  }
  const exited = /cc-desk-tunnel: (\S+) exited (\d+)/.exec(output);
  const name = exited?.[1] ?? '';
  // Otherwise the last line it printed is what is known of why.
  const said = lastLine(output);
  if (/^sshd/i.test(name))
    return phrase(said ? 'desktop:component.sshdSaid' : 'desktop:component.sshdExited', {
      code: exited ? phrase('desktop:component.exitCode', { code: exited[2] }) : '',
      said,
    });
  if (said)
    return phrase(early ? 'desktop:component.notStartedSaid' : 'desktop:component.exitedSaid', {
      said,
    });
  // Ended at once without a word: that is what a program stopped by security software looks like.
  return early
    ? phrase('desktop:component.notStarted', { hint: securityHint })
    : phrase('desktop:component.exited');
}
export const lastLine = (output) =>
  String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('cc-desk-tunnel:'))
    .at(-1)
    ?.slice(0, 300) ?? '';

// The computer's OpenSSH is set to run commands in a shell the bundled one cannot be made to bring back to cmd.exe.
export const unsupportedShell = (path) => phrase('desktop:component.unsupportedShell', { path });

// A bundled program is not where it was installed, which is what a quarantine leaves behind.
export const missingComponent = (name) =>
  phrase('desktop:component.missing', { name, hint: securityHint });
