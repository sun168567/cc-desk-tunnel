import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseFiles } from './release-manifest.mjs';

// Releases the version in apps/desktop/package.json from what the main branch on GitHub holds. Nothing is
// built on this computer: the `package` workflow on GitHub builds every file from that commit, starts each
// client as a check, and attaches them to a draft release this script made, with release.json and
// SHA256SUMS. The release stays a draft unless --publish is given; --prerelease marks it as a preview, which
// the service does not offer as an update. --dry-run only writes the notes. Needs gh (or GH pointing at
// it), signed in.
const root = fileURLToPath(new URL('..', import.meta.url));
const dryRun = process.argv.includes('--dry-run');
const publish = process.argv.includes('--publish');
const prerelease = process.argv.includes('--prerelease');
// A word this script does not know is a mistake, not something to release past: `--help` would otherwise publish.
const unknown = process.argv
  .slice(2)
  .filter((word) => !['--dry-run', '--publish', '--prerelease'].includes(word));
if (unknown.length)
  throw new Error(`Unknown argument ${unknown.join(' ')}. Use --dry-run, --prerelease, --publish.`);
const gh = process.env.GH ?? 'gh';
const run = (file, args, options = {}) =>
  execFileSync(file, args, { cwd: root, encoding: 'utf8', windowsHide: true, ...options });
const git = (...args) => run('git', args).trim();

const version = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')).version;
const tag = `v${version}`;
const section = new RegExp(
  `^## ${version.replaceAll('.', '\\.')}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`,
  'm',
)
  .exec(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'))?.[1]
  .trim();
if (!section) throw new Error(`CHANGELOG.md has no section "## ${version}".`);
const repository = 'https://github.com/sun168567/cc-desk-tunnel';
const [installer, server, ...others] = releaseFiles(version);
// Every release reads the same way: what the project is, this version's section of the change log with its
// headings one level up, then how to get and upgrade to it. A preview carries the same text, so that making
// it the release later changes nothing a reader has seen.
const notes = [
  '> 用桌面客户端驱动云端的 Claude Code，经反向隧道在你自己的电脑上执行。',
  '',
  // The change log links to files beside it; on the release page those links need the whole address.
  section
    .replace(/^### /gm, '## ')
    .replace(/\]\((?![a-z]+:|#)([^)]+)\)/g, `](${repository}/blob/main/$1)`),
  '',
  '---',
  '',
  '## 下载与升级',
  '',
  '- **已在使用**：在客户端的“设置 → 关于与更新”里先升级服务端，再按提示升级客户端；两端需要同一版本。',
  `- **Windows 客户端**：下载 \`${installer}\` 并安装。安装包没有代码签名，SmartScreen 与杀毒软件的提示见[说明](${repository}#杀毒软件与-smartscreen)。`,
  `- **服务端**：新部署按[快速开始](${repository}#快速开始)拉取预构建镜像；\`${server}\` 用于应用内升级或自行从源码构建。`,
  `- **macOS 与 Linux 客户端（实验性）**：${others.map((name) => `\`${name}\``).join('、')}。没有签名，也不带应用内更新，升级时重新下载安装；安装与首次打开见 [macOS 说明](${repository}/blob/main/docs/macos.md)与 [Linux 说明](${repository}/blob/main/docs/linux.md)。`,
  '- **校验**：各文件的 SHA256 在 `SHA256SUMS` 与 `release.json` 中。',
  '',
  `文档：[部署手册](${repository}/blob/main/deploy/README.md) · [变更记录](${repository}/blob/main/CHANGELOG.md) · [安全须知](${repository}#安全须知)`,
].join('\n');
const output = join(root, 'artifacts/release');
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'notes.md'), notes + '\n');

if (dryRun) {
  console.log(
    `The notes of ${tag} are in ${join(output, 'notes.md')}; nothing was sent to GitHub.`,
  );
} else {
  // A release is cut from exactly what the main branch on GitHub holds, so the tag matches the files.
  const commit = git('rev-parse', 'HEAD');
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

  // Always a draft first: what is published is complete.
  let url;
  try {
    url = run(gh, [
      'release',
      'create',
      tag,
      '--draft',
      ...(prerelease ? ['--prerelease', '--latest=false'] : []),
      '--target',
      commit,
      '--title',
      `CC Desk Tunnel ${version}`,
      '--notes-file',
      join(output, 'notes.md'),
    ]).trim();
  } catch (error) {
    // gh has reported a failure after GitHub had made the draft; it is looked for before giving up, or the
    // next attempt would stop at a release that "already exists".
    let made;
    try {
      made = JSON.parse(
        run(gh, ['release', 'view', tag, '--json', 'url,isDraft'], { stdio: 'pipe' }),
      );
    } catch {
      throw error;
    }
    if (!made.isDraft) throw error;
    console.log(`gh reported an error, but the draft of ${tag} was made; going on with it.`);
    url = made.url;
  }
  try {
    const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const runs = () =>
      JSON.parse(
        run(gh, [
          'run',
          'list',
          '--workflow',
          'package.yml',
          '--event',
          'workflow_dispatch',
          '--commit',
          commit,
          '--json',
          'databaseId',
        ]),
      );
    const before = new Set(runs().map((item) => item.databaseId));
    run(gh, ['workflow', 'run', 'package.yml', '--ref', 'main', '-f', `release=${tag}`]);
    let started;
    for (let attempt = 0; !started && attempt < 30; attempt++) {
      wait(5_000);
      started = runs().find((item) => !before.has(item.databaseId));
    }
    if (!started) throw new Error('The package workflow did not start on GitHub.');
    console.log(`GitHub run ${started.databaseId} builds the files of ${tag}.`);
    // Fails when the run does: a release does not go out with a package that did not start. The jobs
    // download Electron and other files, which now and then times out; what failed is tried once more.
    const watch = () =>
      run(gh, ['run', 'watch', String(started.databaseId), '--exit-status', '--interval', '30'], {
        stdio: 'inherit',
      });
    try {
      watch();
    } catch {
      console.log('The run failed; running its failed jobs once more.');
      run(gh, ['run', 'rerun', String(started.databaseId), '--failed']);
      wait(15_000);
      watch();
    }
    const attached = JSON.parse(run(gh, ['release', 'view', tag, '--json', 'assets'])).assets.map(
      (asset) => asset.name,
    );
    const missing = [...releaseFiles(version), 'release.json', 'SHA256SUMS'].filter(
      (name) => !attached.includes(name),
    );
    if (missing.length) throw new Error(`The draft ${tag} lacks ${missing.join(', ')}.`);
  } catch (error) {
    console.log(
      `The draft ${url} is left as it is. Delete it (gh release delete ${tag}) to try again.`,
    );
    throw error;
  }
  if (publish) run(gh, ['release', 'edit', tag, '--draft=false']);
  console.log(`${publish ? 'Published' : 'Draft'} release: ${url}`);
}
