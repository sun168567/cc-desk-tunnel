import { useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { PLUGIN_ARCHIVE_LIMIT, PLUGIN_PART_BYTES } from '@cc-desk-tunnel/protocol';
import type { ServerMessage } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { reach } from './PluginPage.tsx';
import { Modal } from './ui.tsx';

type Archive = Extract<ServerMessage, { type: 'plugin.archive' }>;
const said = (error: unknown) => (error instanceof Error ? error.message : '操作失败。');
const base64 = (bytes: Uint8Array) => {
  let text = '';
  for (let at = 0; at < bytes.length; at += 8192)
    text += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(text);
};

// Installs a plugin from a zip archive: the service says what is in it, without running any of it, and it is put in
// place once the user agrees.
export default function PluginInstall({
  client,
  failed: setFailure,
}: {
  client: ProxyClient;
  // Told why it could not be installed, or nothing once another is tried.
  failed: (message: string | undefined) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [found, setFound] = useState<(Archive & { uploadId: string }) | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setFailure(undefined);
    setBusy(true);
    try {
      if (file.size > PLUGIN_ARCHIVE_LIMIT) throw new Error('压缩包超过 5 MB。');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const uploadId = crypto.randomUUID();
      const send = (at: number, last: boolean) => ({
        type: 'plugin.upload' as const,
        uploadId,
        data: base64(bytes.subarray(at, at + PLUGIN_PART_BYTES)),
        last,
      });
      let at = 0;
      for (; at + PLUGIN_PART_BYTES < bytes.length; at += PLUGIN_PART_BYTES)
        await client.request(send(at, false));
      setFound({ ...(await client.fetch(send(at, true))), uploadId });
    } catch (error) {
      setFailure(said(error));
    } finally {
      setBusy(false);
    }
  }
  async function install() {
    setBusy(true);
    try {
      const done = await client.fetch({ type: 'plugin.install', uploadId: found!.uploadId });
      if (!done.ok) setFailure(done.message);
    } catch (error) {
      setFailure(said(error));
    } finally {
      setBusy(false);
      setFound(null);
    }
  }
  const changed = found?.replaces?.author && found.replaces.author !== found.manifest.author?.name;
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".zip"
        aria-label="插件压缩包"
        hidden
        onChange={({ target }) => {
          const file = target.files?.[0];
          target.value = '';
          if (file) void upload(file);
        }}
      />
      <button
        type="button"
        className="button plugin-install"
        title="从 zip 压缩包安装插件"
        aria-label="安装插件"
        disabled={busy}
        onClick={() => input.current!.click()}
      >
        <Plus />
        <span>安装插件</span>
      </button>
      {found && (
        <Modal
          title={`${found.replaces ? '更新' : '安装'}“${found.manifest.displayName ?? found.manifest.id}”`}
          onClose={() => setFound(null)}
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
              : `${reach.all}装好后由你启用，只启用信得过的。`}
            {changed && '作者和已装的不同，装上后会沿用原来的设置，包括密钥。'}
          </p>
          <div className="plugin-foot">
            <button type="button" className="button" onClick={() => setFound(null)}>
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
      )}
    </>
  );
}
