import { useEffect, useState } from 'react';
import type { IdleCompaction } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { idleCompactionFields as fields } from './setting-fields.ts';
import { Row, Switch } from './ui.tsx';

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
      <h2 className="page-heading">缓存过期前自动压缩</h2>
      <p className="muted page-section-note">
        提示缓存在最后一次请求后 1
        小时过期，过期后压缩要按全价重读整段上下文。开启后，会话空闲到设定时间时，服务端用当前模型执行
        /compact，与手动点“压缩”相同，读取的是缓存；不需要客户端或会话所在电脑在线。这是一次真实请求，会计入额度。关闭时，会话里会在过期前提醒。
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
            <span>
              <strong>{fields.afterMinutes.title}</strong>
              <small>{fields.afterMinutes.detail}</small>
            </span>
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
            <span>
              <strong>{fields.minTokens.title}</strong>
              <small>{fields.minTokens.detail}</small>
            </span>
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
