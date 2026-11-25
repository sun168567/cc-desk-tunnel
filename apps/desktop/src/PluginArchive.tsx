import { useState } from 'react';
import type { ServerMessage } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { reach } from './PluginPage.tsx';
import { Modal } from './ui.tsx';

export type Offered = Extract<ServerMessage, { type: 'plugin.archive' }> & { uploadId: string };

// What is in an archive the service has, which is put in place once the user agrees.
export default function PluginArchive({
  client,
  found,
  failed,
  close,
}: {
  client: ProxyClient;
  found: Offered;
  failed: (message: string) => void;
  close: () => void;
}) {
  const [busy, setBusy] = useState(false);
  async function install() {
    setBusy(true);
    try {
      const done = await client.fetch({ type: 'plugin.install', uploadId: found.uploadId });
      if (!done.ok) failed(done.message);
    } catch (error) {
      failed(error instanceof Error ? error.message : '操作失败。');
    }
    close();
  }
  const changed = found.replaces?.author && found.replaces.author !== found.manifest.author?.name;
  return (
    <Modal
      title={`${found.replaces ? '更新' : '安装'}“${found.manifest.displayName ?? found.manifest.id}”`}
      onClose={close}
    >
      {found.manifest.description && <p>{found.manifest.description}</p>}
      <dl className="plugin-facts">
        <dt>id</dt>
        <dd>{found.manifest.id}</dd>
        <dt>版本</dt>
        <dd>
          {found.replaces && `${found.replaces.version ?? '未写明'} → `}
          {found.manifest.version ?? '未写明'}
          {found.replaces && '，设置和数据保留'}
        </dd>
        {(found.manifest.author || changed) && (
          <>
            <dt>作者</dt>
            <dd>
              {changed && `${found.replaces!.author} → `}
              {found.manifest.author?.name ?? '未写明'}
            </dd>
          </>
        )}
        {found.manifest.repository && (
          <>
            <dt>发布地址</dt>
            <dd>{found.manifest.repository}</dd>
          </>
        )}
        <dt>权限</dt>
        <dd>{reach[found.access]}</dd>
        <dt>订阅的事件</dt>
        <dd>{found.events.join('、') || '无'}</dd>
        <dt>会运行的命令</dt>
        <dd>
          {found.commands.map((command) => (
            <code key={command}>{command}</code>
          ))}
        </dd>
        <dt>文件</dt>
        <dd>{found.files} 个</dd>
      </dl>
      <p className="plugin-notice">
        {found.access === 'own'
          ? '它会收到会话标题、项目路径等事件内容，可以发到网上。只安装信得过的。'
          : `${reach.all}${found.replaces ? '只更新信得过的。' : '装好后由你启用，只启用信得过的。'}`}
        {changed && '作者和已装的不同，装上后会沿用原来的设置，包括密钥。'}
      </p>
      <div className="plugin-foot">
        <button type="button" className="button" onClick={close}>
          取消
        </button>
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={() => void install()}
        >
          {found.replaces ? '更新' : '安装'}
        </button>
      </div>
    </Modal>
  );
}
