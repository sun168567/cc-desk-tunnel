import { useEffect, useState } from 'react';
import type { ProxyClient } from './client.ts';
import type { CacheStats } from './history-cache.ts';
import { Page, Row } from './ui.tsx';

export default function CacheSettings({ client }: { client: ProxyClient }) {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function scan(clear = false) {
    setBusy(true);
    setError('');
    try {
      if (clear) await client.clearCache();
      if (client.cache) setStats(await client.cache.stats());
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void scan();
  }, [client.cache]);
  return (
    <Page
      title="对话缓存"
      intro="已读取的对话保存在本机，重新打开时补充服务端的新记录，也可在登录页离线查看。缓存按服务地址分别保存。"
    >
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="card">
        <Row
          title="当前服务的缓存"
          detail="占用包含数据库与日志文件；对话中的工具输出、图片内容也计入。"
        >
          <span className="setting-value">
            {stats
              ? `${(stats.bytes / 1024 / 1024).toFixed(2)} MiB · ${stats.sessions} 个会话 · ${stats.events} 条记录`
              : '尚未扫描'}
          </span>
        </Row>
        <Row
          title="管理缓存"
          detail="清理本机副本；服务端记录、草稿和连接设置保留。后续读取会重新缓存。"
        >
          <span className="setting-actions">
            <button className="button" disabled={busy || !client.cache} onClick={() => void scan()}>
              扫描占用
            </button>
            <button
              className="button"
              disabled={busy || !client.cache}
              onClick={() => {
                if (window.confirm('清理当前服务的本地对话缓存？离线时将无法查看这些记录。'))
                  void scan(true);
              }}
            >
              清理缓存
            </button>
          </span>
        </Row>
      </div>
    </Page>
  );
}
