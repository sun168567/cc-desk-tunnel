import { useEffect, useState } from 'react';
import type { IdleCompaction } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';

const minutes = [30, 40, 45, 50, 55];
const sizes = [50_000, 100_000, 150_000, 200_000, 300_000];

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
      <p className="muted">
        本项目服务端的设置，不写入 CLI 设置文件。提示缓存在最后一次请求后 1
        小时过期，过期后压缩要按全价重读整段上下文；开启后，服务端在会话空闲到设定时间时用当前模型执行
        /compact，与手动点“压缩”完全相同，读取的是缓存。这是一次真实请求，会计入额度；会话在运行、被终端占用、所在电脑不在线或额度接近上限时不压缩。关闭时，会话里会在过期前提醒。
      </p>
      {failure && (
        <p className="error-text" role="alert">
          {failure}
        </p>
      )}
      {values && (
        <div className="settings-list card">
          <label>
            <span>
              <strong>自动压缩</strong>
              <small>只对写入了 1 小时缓存的会话生效（订阅账号默认如此）</small>
            </span>
            <select
              aria-label="自动压缩"
              disabled={saving}
              value={String(values.enabled)}
              onChange={({ target }) => void save({ enabled: target.value === 'true' })}
            >
              <option value="false">关闭</option>
              <option value="true">开启</option>
            </select>
          </label>
          <label>
            <span>
              <strong>空闲多久后压缩</strong>
              <small>从最后一轮结束算起；关闭自动压缩时，到这个时间起提醒</small>
            </span>
            <select
              aria-label="空闲多久后压缩"
              disabled={saving}
              value={String(values.afterMinutes)}
              onChange={({ target }) => void save({ afterMinutes: Number(target.value) })}
            >
              {[...new Set([...minutes, values.afterMinutes])]
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
              <strong>上下文至少</strong>
              <small>小于这个大小的会话不压缩，也不提醒</small>
            </span>
            <select
              aria-label="上下文至少"
              disabled={saving}
              value={String(values.minTokens)}
              onChange={({ target }) => void save({ minTokens: Number(target.value) })}
            >
              {[...new Set([...sizes, values.minTokens])]
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
