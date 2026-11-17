import { ChevronRight } from 'lucide-react';
import type { NativeMetrics } from '@cc-desk-tunnel/protocol';
import { quotaFigures } from './quota.ts';
import './quota-summary.css';

const tone = (used: number) => (used >= 90 ? 'danger' : used >= 70 ? 'warn' : '');
export function QuotaSummary({
  metrics,
  connected,
  emptyMessage = '暂未获取额度',
  onOpen,
}: {
  metrics: NativeMetrics | null;
  connected: boolean;
  emptyMessage?: string;
  onOpen: () => void;
}) {
  const figures = quotaFigures(metrics?.rateLimits);
  const unavailable = metrics?.rateLimits?.available === false;
  return (
    <div className="sidebar-quota">
      <button type="button" className="quota-summary" aria-label="查看订阅用量" onClick={onOpen}>
        <span className="quota-summary-heading">
          额度已用
          <ChevronRight aria-hidden="true" />
        </span>
        <span className="quota-summary-values">
          {figures.length
            ? figures.map((figure, index) => (
                <span key={figure.label} className={tone(figure.used)}>
                  {index > 0 && <span className="quota-separator">·</span>}
                  {figure.label} {figure.used}%
                </span>
              ))
            : unavailable
              ? '未提供订阅额度'
              : emptyMessage}
        </span>
        {!connected && figures.length > 0 && (
          <span className="quota-summary-offline">已断线 · 最近读数</span>
        )}
      </button>
    </div>
  );
}
