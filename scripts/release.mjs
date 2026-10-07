import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Builds the release files for the version in apps/desktop/package.json and uploads them to a GitHub release.
// The release stays a draft unless --publish is given; --dry-run only builds. Needs gh (or GH pointing at it) and GH_TOKEN.
const root = fileURLToPath(new URL('..', import.meta.url));
const dryRun = process.argv.includes('--dry-run');
const publish = process.argv.includes('--publish');
const gh = process.env.GH ?? 'gh';
const run = (file, args, options = {}) =>
  execFileSync(file, args, { cwd: root, encoding: 'utf8', windowsHide: true, ...options });
const git = (...args) => run('git', args).trim();

const version = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')).version;
const protocol = Number(
  /PROTOCOL_VERSION = (\d+)/.exec(
    readFileSync(join(root, 'packages/protocol/src/index.ts'), 'utf8'),
  )[1],
);
// Raised whenever the image must be rebuilt for a release to run; see deploy/docker/runtime-level.
const runtime = Number(readFileSync(join(root, 'deploy/docker/runtime-level'), 'utf8'));
const tag = `v${version}`;
const notes = new RegExp(
  `^## ${version.replaceAll('.', '\\.')}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`,
  'm',
)
  .exec(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'))?.[1]
  .trim();
if (!notes) throw new Error(`CHANGELOG.md has no section "## ${version}".`);

// A release is cut from exactly what the main branch on GitHub holds, so the tag matches the files.
const commit = git('rev-parse', 'HEAD');
if (!dryRun) {
  if (git('status', '--porcelain')) throw new Error('Commit or discard local changes first.');
  const remote = run(gh, ['api', 'repos/{owner}/{repo}/commits/main', '--jq', '.sha']).trim();
  if (remote !== commit) throw new Error('Check out the current main branch from GitHub first.');
  let exists = true;
  try {
    run(gh, ['release', 'view', tag], { stdio: 'pipe' });
  } catch {
    exists = false;
  }
  if (exists) throw new Error(`Release ${tag} already exists; raise the version.`);
}

const output = join(root, 'artifacts/release');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const installer = `CC-Desk-Tunnel-Setup-${version}-x64.exe`;
const server = `cc-desk-tunnel-server-${version}.tar.gz`;
// Packaging now and then fails on a file another program holds open for a moment; waiting is enough.
for (let attempt = 1; ; attempt++) {
  try {
    run(process.execPath, ['scripts/package-windows.mjs'], { stdio: 'inherit' });
    break;
  } catch (error) {
    if (attempt === 3) throw error;
    console.log('Packaging failed; trying again in a minute.');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  }
}
copyFileSync(join(root, 'artifacts/windows', installer), join(output, installer));
run(process.execPath, ['scripts/package-server.mjs', join(output, server)], { stdio: 'inherit' });

const files = [installer, server].map((name) => ({
  name,
  size: statSync(join(output, name)).size,
  sha256: createHash('sha256')
    .update(readFileSync(join(output, name)))
    .digest('hex'),
}));
// release.json is what programs read; SHA256SUMS is the same hashes for `sha256sum -c`.
writeFileSync(
  join(output, 'release.json'),
  JSON.stringify({ version, protocol, runtime, commit, files }, null, 2) + '\n',
);
writeFileSync(
  join(output, 'SHA256SUMS'),
  files.map((file) => `${file.sha256}  ${file.name}\n`).join(''),
);
writeFileSync(join(output, 'notes.md'), notes + '\n');
for (const file of files) console.log(`${file.sha256}  ${file.name}  (${file.size} bytes)`);

if (dryRun) {
  console.log(`Built ${tag} in ${output}; nothing uploaded.`);
} else {
  const url = run(gh, [
    'release',
    'create',
    tag,
    ...(publish ? [] : ['--draft']),
    '--target',
    commit,
    '--title',
    `CC Desk Tunnel ${version}`,
    '--notes-file',
    join(output, 'notes.md'),
    ...[installer, server, 'release.json', 'SHA256SUMS'].map((name) => join(output, name)),
  ]).trim();
  console.log(`${publish ? 'Published' : 'Draft'} release: ${url}`);
}
