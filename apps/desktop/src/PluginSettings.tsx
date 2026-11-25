import { useState } from 'react';
import { ChevronRight, ScrollText } from 'lucide-react';
import type { Plugin } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import PluginLog from './PluginLog.tsx';
import PluginPage, { reach, titleOf, troubleOf } from './PluginPage.tsx';
import { IconButton, Page, Switch } from './ui.tsx';

// The service's plugins, each opening a page of its own.
export default function PluginSettings({
  client,
  plugins,
  shown,
  open,
}: {
  client: ProxyClient;
  plugins: Plugin[];
  shown?: string;
  open: (id: string | undefined) => void;
}) {
  const [failure, setFailure] = useState<{ id: string; message: string }>();
  const [logging, setLogging] = useState<Plugin>();
  const plugin = plugins.find(({ id }) => id === shown);
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
  if (plugin)
    return (
      <PluginPage
        key={plugin.id}
        client={client}
        plugin={plugin}
        enable={(enabled) => enable(plugin, enabled)}
        failure={failure?.id === plugin.id ? failure.message : undefined}
        back={() => open(undefined)}
      />
    );
  return (
    <Page title="插件" intro="保存在服务端，对所有连接到它的设备生效。">
      {/* What its row says already is not said twice. */}
      {failure && !plugins.some(({ problem }) => problem === failure.message) && (
        <p className="error-text" role="alert">
          {failure.message}
        </p>
      )}
      <div className="settings-list card">
        {!plugins.length && (
          <p className="muted plugin-empty">
            还没有插件。把插件放进服务端数据目录的 plugins，它就会出现在这里。
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
                  <ChevronRight />
                </strong>
                {item.description && <small>{item.description}</small>}
                {trouble && <small className="plugin-trouble">{trouble.text}</small>}
              </button>
              <span className="plugin-controls">
                <IconButton title={`${title}：日志`} onClick={() => setLogging(item)}>
                  <ScrollText />
                </IconButton>
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
