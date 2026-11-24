import { useEffect, useState } from 'react';
import type { IdleCompaction } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { idleCompactionFields as fields } from './setting-fields.ts';
import { Row, SettingText, SettingsHeading, Switch } from './ui.tsx';

// The service's own setting, kept with its sessions and not in the CLI's file: before an idle session's one-hour prompt
// cache lapses, the service compacts it as the compact button does. Each change is saved at once.
export default function IdleCompactionSettings({ client }: { client: ProxyClient }) {
  const [values, setValues] = useState<IdleCompaction | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let current = true;
    client.fetch({ type: 'compaction.get' }).then(
      (reply) => current && setValues(reply.values),
      (error: Error) => current && setFailure(error.message),
    );
    return () => {
      current = false;
    };
  }, [client]);
  async function save(change: Partial<IdleCompaction>) {
    setFailure(null);
    setSaving(true);
    try {
      setValues((await client.fetch({ type: 'compaction.update', values: change })).values);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '保存失败。');
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <SettingsHeading help="context#idle">缓存过期前自动压缩</SettingsHeading>
      <p className="muted page-section-note">
        会话空闲到设定时间，服务端趁缓存还在替你压缩，回来时不用全价重读。电脑不用在线；压缩计入额度。
      </p>
      {failure && (
        <p className="error-text" role="alert">
          {failure}
        </p>
      )}
      {values && (
        <div className="settings-list card">
          <Row title={fields.enabled.title} detail={fields.enabled.detail}>
            <Switch
              label={fields.enabled.title}
              checked={values.enabled}
              disabled={saving}
              onChange={(enabled) => void save({ enabled })}
            />
          </Row>
          <label>
            <SettingText title={fields.afterMinutes.title} detail={fields.afterMinutes.detail} />
            <select
              aria-label={fields.afterMinutes.title}
              disabled={saving}
              value={String(values.afterMinutes)}
              onChange={({ target }) => void save({ afterMinutes: Number(target.value) })}
            >
              {[...new Set([...fields.afterMinutes.options, values.afterMinutes])]
                .sort((a, b) => a - b)
                .map((value) => (
                  <option key={value} value={value}>
                    {value} 分钟
                  </option>
                ))}
            </select>
          </label>
          <label>
            <SettingText title={fields.minTokens.title} detail={fields.minTokens.detail} />
            <select
              aria-label={fields.minTokens.title}
              disabled={saving}
              value={String(values.minTokens)}
              onChange={({ target }) => void save({ minTokens: Number(target.value) })}
            >
              {[...new Set([...fields.minTokens.options, values.minTokens])]
                .sort((a, b) => a - b)
                .map((value) => (
                  <option key={value} value={value}>
                    {value / 1000}K tokens
                  </option>
                ))}
            </select>
          </label>
        </div>
      )}
    </>
  );
}
