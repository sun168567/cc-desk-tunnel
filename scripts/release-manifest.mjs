import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Describes the files of a release, which the `package` workflow has gathered in one directory: release.json
// is what programs read, SHA256SUMS the same hashes for `sha256sum -c`. A release has exactly these files: the
// desktop packages, the server bundle and the ccdt packages; one missing or one too many stops it.
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = resolve(process.argv[2] ?? 'artifacts/release');
const version = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')).version;
export const releaseFiles = (version) => [
  `CC-Desk-Tunnel-Setup-${version}-x64.exe`,
  `cc-desk-tunnel-server-${version}.tar.gz`,
  `CC-Desk-Tunnel-${version}-linux-amd64.deb`,
  `CC-Desk-Tunnel-${version}-mac-arm64.dmg`,
  `CC-Desk-Tunnel-${version}-mac-x64.dmg`,
  `ccdt-${version}-windows-x64.zip`,
  `ccdt-${version}-linux-x64.tar.gz`,
  `ccdt-${version}-mac-arm64.tar.gz`,
  `ccdt-${version}-mac-x64.tar.gz`,
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const protocol = Number(
    /PROTOCOL_VERSION = (\d+)/.exec(
      readFileSync(join(root, 'packages/protocol/src/index.ts'), 'utf8'),
    )[1],
  );
  // Raised whenever the image must be rebuilt for a release to run; see deploy/docker/runtime-level.
  const runtime = Number(readFileSync(join(root, 'deploy/docker/runtime-level'), 'utf8'));
  const commit =
    process.env.GITHUB_SHA ??
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const names = releaseFiles(version);
  const found = readdirSync(directory).sort();
  if (found.join() !== [...names].sort().join())
    throw new Error(`Expected ${names.join(', ')} in ${directory}; found ${found.join(', ')}.`);
  const files = names.map((name) => ({
    name,
    size: statSync(join(directory, name)).size,
    sha256: createHash('sha256')
      .update(readFileSync(join(directory, name)))
      .digest('hex'),
  }));
  writeFileSync(
    join(directory, 'release.json'),
    JSON.stringify({ version, protocol, runtime, commit, files }, null, 2) + '\n',
  );
  writeFileSync(
    join(directory, 'SHA256SUMS'),
    files.map((file) => `${file.sha256}  ${file.name}\n`).join(''),
  );
  for (const file of files) console.log(`${file.sha256}  ${file.name}  (${file.size} bytes)`);
}
