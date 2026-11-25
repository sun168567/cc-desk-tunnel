import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PLUGIN_ARCHIVE_LIMIT, releasesOf } from '@cc-desk-tunnel/protocol';
import type { PluginManifest } from '@cc-desk-tunnel/protocol';
import { DomainError } from './errors.ts';
import { readArchive } from './plugin-install.ts';

export const GITHUB = 'https://api.github.com';
const failed = (message: string) => new DomainError('plugin_update', message);

// A release of a plugin: its version, and where its archive is.
export type PluginRelease = { version: string; url: string; digest?: string };
const releaseSchema = z.object({
  tag_name: z.string(),
  zipball_url: z.url(),
  assets: z.array(
    z.object({ name: z.string(), browser_download_url: z.url(), digest: z.string().nullish() }),
  ),
});

async function get(url: string, accept: string, redirect: RequestRedirect) {
  const headers = {
    Accept: accept,
    'User-Agent': 'cc-desk-tunnel',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const parts: Uint8Array[] = [];
  let status: number;
  try {
    const response = await fetch(url, { headers, redirect, signal: AbortSignal.timeout(60_000) });
    ({ status } = response);
    let size = 0;
    for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += part.length;
      if (size > PLUGIN_ARCHIVE_LIMIT) throw failed('压缩包超过 5 MB。');
      parts.push(part);
    }
  } catch (error) {
    throw error instanceof DomainError ? error : failed('连不上 GitHub。');
  }
  if (status === 200) return Buffer.concat(parts);
  // Whoever has the name now may be someone else.
  if (status >= 300 && status < 400)
    throw failed('发布地址的仓库已改名或转手，请自行确认后安装压缩包。');
  if (status === 404) throw failed('发布地址没有发布过版本，或不公开。');
  if (status === 403 || status === 429) throw failed('GitHub 限制了请求次数，请稍后再试。');
  throw failed(`GitHub 请求失败（${status}）。`);
}

// The latest release in the plugin's repository.
export async function latestRelease(
  { id, repository }: Partial<PluginManifest>,
  api: string,
): Promise<PluginRelease> {
  const name = releasesOf(repository);
  if (!name) throw failed('没有写明 GitHub 的发布地址。');
  const answer = await get(
    `${api}/repos/${name}/releases/latest`,
    'application/vnd.github+json',
    'manual',
  );
  const release = releaseSchema.safeParse(JSON.parse(answer.toString())).data;
  const version = /^v?(\d+\.\d+\.\d+)$/.exec(release?.tag_name ?? '')?.[1];
  if (!release || !version) throw failed('最新发布的标签不是 v1.2.3 这样的版本号。');
  // Its own archive, or else the only one, or else the repository as it was.
  const archives = release.assets.filter((asset) => asset.name.endsWith('.zip'));
  const asset =
    archives.find((item) => item.name === `${id}.zip`) ??
    (archives.length === 1 ? archives[0] : undefined);
  const url = asset?.browser_download_url ?? release.zipball_url;
  return { version, url, digest: asset?.digest ?? undefined };
}

// The release's archive, which must be of the plugin and the version it was found for.
export async function downloadRelease(id: string, { version, url, digest }: PluginRelease) {
  const data = await get(url, '*/*', 'follow');
  if (digest && digest !== `sha256:${createHash('sha256').update(data).digest('hex')}`)
    throw failed('下载的压缩包校验失败。');
  const archive = readArchive(data);
  const { manifest } = archive;
  if (manifest.id !== id) throw failed(`发布的压缩包是另一个插件：${manifest.id}。`);
  if (manifest.version !== version)
    throw failed(`发布的是 ${version}，压缩包里写的是 ${manifest.version ?? '没有版本'}。`);
  return archive;
}
