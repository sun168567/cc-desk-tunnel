import { execFileSync } from 'node:child_process';

const SERVICE = 'CC Desk Tunnel CLI';
// A store that waits on something, such as a dialog to unlock it, is given up after a while.
const run = (file, args, input) =>
  execFileSync(file, args, {
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
const has = (file) => {
  try {
    run(process.platform === 'win32' ? 'where.exe' : 'which', [file]);
    return true;
  } catch {
    return false;
  }
};
const dpapi = (method, value) =>
  run(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName System.Security; $v = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${method}($v, $null, 'CurrentUser'))`,
    ],
    value,
  ).trim();

// The service token, kept the way the system keeps secrets for the current account: DPAPI on Windows, the login
// keychain on macOS, the Secret Service (GNOME Keyring, KWallet) on Linux. A store that is there may not work: the
// Secret Service needs a desktop session, which a server reached over SSH does not have, and the keychain may be
// locked to a login over SSH. Then, as where there is no store, the token is kept in the settings file, which only
// this account can read; `CCDT_TOKEN` avoids keeping it at all.
export function protect(server, token, platform = process.platform) {
  try {
    const kept = store(server, token, platform);
    if (kept && reveal(server, kept) === token) return kept;
  } catch {}
  return { store: 'file', data: token };
}

function store(server, token, platform) {
  if (platform === 'win32')
    return { store: 'dpapi', data: dpapi('Protect', Buffer.from(token).toString('base64')) };
  if (platform === 'darwin') {
    run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', server, '-w', token]);
    return { store: 'keychain' };
  }
  if (!has('secret-tool')) return undefined;
  run('secret-tool', ['store', `--label=${SERVICE}`, 'service', SERVICE, 'server', server], token);
  return { store: 'secret-service' };
}

export function reveal(server, kept) {
  if (!kept) return undefined;
  try {
    if (kept.store === 'dpapi')
      return Buffer.from(dpapi('Unprotect', kept.data), 'base64').toString('utf8');
    if (kept.store === 'keychain')
      return run('security', ['find-generic-password', '-s', SERVICE, '-a', server, '-w']).trim();
    if (kept.store === 'secret-service')
      return run('secret-tool', ['lookup', 'service', SERVICE, 'server', server]).trim();
    if (kept.store === 'file') return kept.data;
  } catch {}
  return undefined;
}

export function discard(server, kept) {
  try {
    if (kept?.store === 'keychain')
      run('security', ['delete-generic-password', '-s', SERVICE, '-a', server]);
    if (kept?.store === 'secret-service')
      run('secret-tool', ['clear', 'service', SERVICE, 'server', server]);
  } catch {}
}
