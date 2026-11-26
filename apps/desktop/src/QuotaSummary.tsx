import { ChevronRight } from 'lucide-react';
import type { AccountQuota } from '@cc-desk-tunnel/protocol';
import { useT } from './i18n.ts';
import { quotaFigures } from './quota.ts';
import './quota-summary.css';

const tone = (used: number) => (used >= 90 ? 'danger' : used >= 70 ? 'warn' : '');
export function QuotaSummary({
  quota,
  connected,
  emptyMessage,
  onOpen,
}: {
  quota: AccountQuota | null;
  connected: boolean;
  emptyMessage?: string;
  onOpen: () => void;
}) {
  const t = useT();
  const figures = quotaFigures(t, quota?.rateLimits);
  const unavailable = quota?.rateLimits?.available === false;
  return (
    <div className="sidebar-quota">
      <button
        type="button"
        className="quota-summary"
        aria-label={t('account:quota.openUsage')}
        onClick={onOpen}
      >
        <span className="quota-summary-heading">
          {t('account:quota.used')}
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
              ? t('account:quota.unavailable')
              : (emptyMessage ?? t('account:quota.none'))}
        </span>
        {!connected && figures.length > 0 && (
          <span className="quota-summary-offline">{t('account:quota.stale')}</span>
        )}
      </button>
    </div>
  );
}
