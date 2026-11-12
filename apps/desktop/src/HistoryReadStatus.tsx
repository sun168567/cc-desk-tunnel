import { useEffect, useState } from 'react';
import type { HistoryState } from './client.ts';

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export default function HistoryReadStatus({
  read,
  hasEarlier,
}: {
  read: NonNullable<HistoryState['read']>;
  hasEarlier: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  const active = read.phase === 'waiting' || read.phase === 'processing';
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, read.requestId]);
  const seconds = Math.max(0, Math.floor(((read.finishedAt ?? now) - read.startedAt) / 1000));
  const label =
    read.phase === 'complete'
      ? read.content === false
        ? hasEarlier
          ? '已更新会话状态，尚未加载更早对话'
          : '已到最早记录'
        : '历史记录已加载'
      : read.phase === 'failed'
        ? (read.error ?? '历史读取未完成，请重试')
        : read.phase === 'processing'
          ? '历史数据已收到，正在处理记录'
          : read.received
            ? '正在读取服务器历史'
            : '等待服务器返回历史';
  return (
    <div className="history-status history-read-status" role="status">
      {label}
      {read.received > 0 && (
        <span title="本次读取期间连接收到的数据，包含同时到达的状态或实时消息；不是整页历史的总大小。">
          {' · '}连接已接收 {bytes(read.received)}
        </span>
      )}
      {' · '}
      {active ? '已等待' : '用时'} {seconds} 秒
    </div>
  );
}
