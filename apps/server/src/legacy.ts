import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Deployments made before 0.2.10 ran frp for the execution channel. An upgrade from the client replaces only
// the program, so its certificate, key and settings would stay in the data directory for good; they are
// removed here, once. Nothing else is touched: the files are the ones the old settings name, and never the
// service's own certificate.
export function removeFrpLeftovers(
  env: NodeJS.ProcessEnv = process.env,
  execArgv: string[] = process.execArgv,
) {
  const own = [env.PROXY_TLS_CERT, env.PROXY_TLS_KEY].map((file) => file && resolve(file));
  for (const file of [env.FRPS_TLS_CERT, env.FRPS_TLS_KEY])
    if (file && !own.includes(resolve(file)))
      try {
        rmSync(file, { force: true });
      } catch {
        // A file that cannot be removed is only left where it was.
      }
  // The settings come from the file Node was started with; the service has no other name for it.
  const file = execArgv.find((argument) => argument.startsWith('--env-file='))?.slice(11);
  if (!file) return;
  try {
    const lines = readFileSync(file, 'utf8').split('\n');
    const kept = lines.filter((line) => !/^(FRPS_[A-Z_]+|PROXY_PUBLIC_HOST)=/.test(line));
    if (kept.length === lines.length) return;
    writeFileSync(`${file}.new`, kept.join('\n'), { mode: 0o600 });
    renameSync(`${file}.new`, file);
  } catch {
    rmSync(`${file}.new`, { force: true });
  }
}
