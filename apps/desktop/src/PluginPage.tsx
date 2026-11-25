import { ChevronLeft } from 'lucide-react';
import type { Plugin } from '@cc-desk-tunnel/protocol';
import { Page, Row, SettingsHeading, Switch } from './ui.tsx';

export const titleOf = (plugin: Plugin) => plugin.title ?? plugin.id;
// What a plugin reaches, in a word, and what that comes to for one that reaches everything.
export const reach = {
  own: '只能读写自己的文件，可以联网',
  full: '完整权限',
  unlimited: '不受限制（服务端的系统不支持限制）',
  all: '它能读到服务端上的凭据，也能在你的电脑上执行命令。',
};
// What is to be told of a plugin, and in a word; nothing of one that goes well.
export function troubleOf({ enabled, problem, failure }: Plugin) {
  if (problem) return { word: enabled ? '未运行' : '未启用', text: problem };
  if (!enabled || !failure) return undefined;
  const at = new Date(failure.at).toLocaleString('zh-CN');
  return { word: '上次失败', text: `${failure.message}（${at}）` };
}

// A plugin's own page.
export default function PluginPage({
  plugin,
  enable,
  failure,
  back,
}: {
  plugin: Plugin;
  enable: (enabled: boolean) => void;
  failure?: string;
  back: () => void;
}) {
  const title = titleOf(plugin);
  const trouble = troubleOf(plugin);
  const { version, author, homepage, repository } = plugin;
  return (
    <Page
      title={title}
      intro={plugin.description}
      before={
        <button type="button" className="plugin-back" onClick={back}>
          <ChevronLeft />
          插件
        </button>
      }
    >
      <div className="settings-list card">
        <Row title="启用插件" detail="停用后不运行它的任何代码，设置保留。">
          <Switch label={`启用 ${title}`} checked={plugin.enabled} onChange={enable} />
        </Row>
      </div>
      {(failure ?? trouble) && (
        <p className="plugin-notice" role="alert">
          {failure ?? `${trouble!.word}：${trouble!.text}`}
        </p>
      )}
      <SettingsHeading>关于</SettingsHeading>
      <div className="settings-list card">
        <Row title="id">
          <span className="setting-value">{plugin.id}</span>
        </Row>
        <Row title="权限">
          <span className="setting-value">{reach[plugin.access]}</span>
        </Row>
        {version && (
          <Row title="版本">
            <span className="setting-value">{version}</span>
          </Row>
        )}
        {author && (
          <Row title="作者">
            {author.url ? (
              <Link url={author.url}>{author.name}</Link>
            ) : (
              <span className="setting-value">{author.name}</span>
            )}
          </Row>
        )}
        {homepage && (
          <Row title="主页">
            <Link url={homepage}>{homepage}</Link>
          </Row>
        )}
        {repository && (
          <Row title="发布地址">
            <Link url={repository}>{repository}</Link>
          </Row>
        )}
      </div>
    </Page>
  );
}

function Link({ url, children }: { url: string; children: string }) {
  return (
    <button
      type="button"
      className="text-link plugin-link"
      title={url}
      onClick={() =>
        window.desktop
          ? void window.desktop.openLink(url)
          : void window.open(url, '_blank', 'noopener')
      }
    >
      {children}
    </button>
  );
}
