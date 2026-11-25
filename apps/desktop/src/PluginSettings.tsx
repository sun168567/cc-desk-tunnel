import { useEffect, useState } from 'react';
import { ChevronRight, CircleArrowUp, ScrollText, Trash2 } from 'lucide-react';
import { COMPOSER_SLOTS } from '@cc-desk-tunnel/protocol';
import type { Plugin } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import PluginArchive from './PluginArchive.tsx';
import type { Offered } from './PluginArchive.tsx';
import PluginInstall from './PluginInstall.tsx';
import PluginLog from './PluginLog.tsx';
import PluginPage, { reach, titleOf, troubleOf } from './PluginPage.tsx';
import { IconButton, Page, Switch } from './ui.tsx';

// The service's plugins, each opening a page of its own.
export default function PluginSettings({
  client,
  plugins,
  shown,
  open,
  browser,
}: {
  client: ProxyClient;
  plugins: Plugin[];
  shown?: string;
  open: (id: string | undefined) => void;
  // Where plugins are set but neither installed nor removed.
  browser: boolean;
}) {
  const [failure, setFailure] = useState<{ id: string; message: string }>();
  const [logging, setLogging] = useState<Plugin>();
  const [found, setFound] = useState<Offered>();
  const [updating, setUpdating] = useState<string>();
  const plugin = plugins.find(({ id }) => id === shown);
  useEffect(() => {
    client.request({ type: 'plugin.checkAll' }).catch(() => {});
  }, [client]);
  const act = async (id: string, work: Promise<unknown>) => {
    setFailure(undefined);
    try {
      await work;
    } catch (error) {
      setFailure({ id, message: error instanceof Error ? error.message : '操作失败。' });
    }
  };
  const enable = (plugin: Plugin, enabled: boolean) => {
    const { id, access } = plugin;
    const asked = `启用“${titleOf(plugin)}”？${reach.all}只启用信得过的。`;
    if (enabled && access !== 'own' && !window.confirm(asked)) return;
    void act(id, client.request({ type: 'plugin.enable', id, enabled }));
  };
  const update = ({ id }: Plugin) => {
    const uploadId = crypto.randomUUID();
    setUpdating(id);
    const download = client.fetch({ type: 'plugin.download', id, uploadId });
    void act(
      id,
      download
        .then((archive) => setFound({ ...archive, uploadId }))
        .finally(() => setUpdating(undefined)),
    );
  };
  const archive = found && (
    <PluginArchive
      client={client}
      found={found}
      failed={(message) => setFailure({ id: found.replaces ? found.manifest.id : '', message })}
      close={() => setFound(undefined)}
    />
  );
  if (plugin)
    return (
      <PluginPage
        key={plugin.id}
        client={client}
        plugin={plugin}
        enable={(enabled) => enable(plugin, enabled)}
        failure={failure?.id === plugin.id ? failure.message : undefined}
        update={browser ? undefined : () => update(plugin)}
        updating={!!updating}
        back={() => open(undefined)}
      >
        {archive}
      </PluginPage>
    );
  return (
    <Page
      title="插件"
      intro={
        <>
          保存在服务端，对所有连接到它的设备生效。
          <span className="plugin-tags">
            <span className="badge" title={`输入框旁的插件按钮，最多同时 ${COMPOSER_SLOTS} 个`}>
              输入框插槽 {plugins.filter(({ composerSlot }) => composerSlot).length}/
              {COMPOSER_SLOTS}
            </span>
          </span>
        </>
      }
      actions={
        !browser && (
          <PluginInstall
            client={client}
            offer={setFound}
            failed={(message) => setFailure(message ? { id: '', message } : undefined)}
          />
        )
      }
    >
      {/* What its row says already is not said twice. */}
      {failure && !plugins.some(({ problem }) => problem === failure.message) && (
        <p className="error-text" role="alert">
          {failure.message}
        </p>
      )}
      <div className="settings-list card">
        {!plugins.length && (
          <p className="muted plugin-empty">
            还没有插件。插件也可以直接放进服务端数据目录的 plugins，放进去就会出现在这里。
          </p>
        )}
        {plugins.map((item) => {
          const title = titleOf(item);
          const trouble = troubleOf(item);
          return (
            <div className="setting-row plugin-row" key={item.id}>
              <button type="button" className="plugin-open" onClick={() => open(item.id)}>
                <strong>
                  {title}
                  {trouble && <i className="badge plugin-badge">{trouble.word}</i>}
                  {item.newer && (
                    <i className="badge plugin-newer" title={item.newer}>
                      新版本
                    </i>
                  )}
                  <ChevronRight />
                </strong>
                {item.description && <small>{item.description}</small>}
                {trouble && <small className="plugin-trouble">{trouble.text}</small>}
              </button>
              <span className="plugin-controls">
                {item.newer && !browser && (
                  <IconButton
                    title={`更新 ${title}`}
                    disabled={!!updating}
                    onClick={() => update(item)}
                  >
                    <CircleArrowUp />
                  </IconButton>
                )}
                <IconButton title={`${title}：日志`} onClick={() => setLogging(item)}>
                  <ScrollText />
                </IconButton>
                {!browser && (
                  <IconButton
                    title={`删除 ${title}`}
                    onClick={() =>
                      window.confirm(`删除“${title}”，连同它的设置、数据和日志？`) &&
                      void act(item.id, client.request({ type: 'plugin.remove', id: item.id }))
                    }
                  >
                    <Trash2 />
                  </IconButton>
                )}
                <Switch
                  label={`启用 ${title}`}
                  checked={item.enabled}
                  onChange={(enabled) => enable(item, enabled)}
                />
              </span>
            </div>
          );
        })}
      </div>
      {archive}
      {logging && (
        <PluginLog
          client={client}
          id={logging.id}
          title={titleOf(logging)}
          close={() => setLogging(undefined)}
        />
      )}
    </Page>
  );
}
