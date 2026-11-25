import { useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { PLUGIN_ARCHIVE_LIMIT, PLUGIN_PART_BYTES } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import type { Offered } from './PluginArchive.tsx';

const said = (error: unknown) => (error instanceof Error ? error.message : '操作失败。');
const base64 = (bytes: Uint8Array) => {
  let text = '';
  for (let at = 0; at < bytes.length; at += 8192)
    text += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(text);
};

// Uploads a plugin's zip archive to the service, which says what is in it without running any of it.
export default function PluginInstall({
  client,
  offer,
  failed: setFailure,
}: {
  client: ProxyClient;
  offer: (found: Offered) => void;
  // Told why it could not be installed, or nothing once another is tried.
  failed: (message: string | undefined) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
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
      offer({ ...(await client.fetch(send(at, true))), uploadId });
    } catch (error) {
      setFailure(said(error));
    } finally {
      setBusy(false);
    }
  }
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
    </>
  );
}
