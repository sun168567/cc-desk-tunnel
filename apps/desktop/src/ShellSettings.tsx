import { useState } from 'react';
import type { DeviceShell } from '@cc-desk-tunnel/protocol';
import type { ConnectedDevice, ProxyClient } from './client.ts';
import { shellField } from './setting-fields.ts';
import { SettingText } from './ui.tsx';

// The shell Claude is told the user prefers for scripts on this Windows computer. Git Bash is listed whether or not the
// computer has it, and can be chosen once it does. The service keeps the choice for this computer alone and lists it
// with the computer, so the value shown is the one it has; each session hears of a change with its next message.
export default function ShellSettings({
  client,
  here,
}: {
  client: ProxyClient;
  here: ConnectedDevice;
}) {
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const has = (shell: DeviceShell) => !!here.shells?.includes(shell);
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
        PowerShell 7 随客户端自带；装了 Git for Windows 还能用 Git
        Bash。改动从每个会话的下一条消息起生效。
      </p>
      {failure && (
        <p className="error-text" role="alert">
          {failure}
        </p>
      )}
      <div className="settings-list card">
        <label>
          <SettingText title={shellField.title} detail={shellField.detail} help={shellField.help} />
          <select
            aria-label={shellField.title}
            disabled={saving}
            value={here.shell ?? ''}
            onChange={({ target }) => void save((target.value || null) as DeviceShell | null)}
          >
            <option value="">{shellField.unset}</option>
            {shellField.options.map(([shell, name]) => (
              <option key={shell} value={shell} disabled={!has(shell)}>
                {has(shell) ? name : `${name}（未检测到）`}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!has('bash') && <p className="muted page-section-note">{shellField.missing}</p>}
    </>
  );
}
