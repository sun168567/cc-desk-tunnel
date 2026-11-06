import { useState } from 'react';
import type { DeviceShell } from '@cc-desk-tunnel/protocol';
import type { ConnectedDevice, ProxyClient } from './client.ts';
import { shellField } from './setting-fields.ts';

// The shell Claude is told the user prefers for scripts on this computer, where it has both PowerShell and Git Bash.
// The service keeps the choice for this computer alone and lists it with the computer, so the value shown is the one
// it has; each session hears of a change with its next message.
export default function ShellSettings({
  client,
  here,
}: {
  client: ProxyClient;
  here: ConnectedDevice;
}) {
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function save(shell: DeviceShell | null) {
    setFailure(null);
    setSaving(true);
    try {
      await client.request({ type: 'device.shell', shell });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '保存失败。');
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <h2 className="page-heading">脚本用哪种 Shell</h2>
      <p className="muted page-section-note">
        Claude 在这台电脑上执行命令时，两种 Shell 都可以用：PowerShell 7 随客户端自带，Git Bash
        来自这台电脑安装的 Git for Windows。改动在每个会话的下一条消息时告诉 Claude。
      </p>
      {failure && (
        <p className="error-text" role="alert">
          {failure}
        </p>
      )}
      <div className="settings-list card">
        <label>
          <span>
            <strong>{shellField.title}</strong>
            <small>{shellField.detail}</small>
          </span>
          <select
            aria-label={shellField.title}
            disabled={saving}
            value={here.shell ?? ''}
            onChange={({ target }) => void save((target.value || null) as DeviceShell | null)}
          >
            <option value="">{shellField.unset}</option>
            {shellField.options
              .filter(([shell]) => here.shells?.includes(shell))
              .map(([shell, name]) => (
                <option key={shell} value={shell}>
                  {name}
                </option>
              ))}
          </select>
        </label>
      </div>
    </>
  );
}
