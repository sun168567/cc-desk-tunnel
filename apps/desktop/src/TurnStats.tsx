import { Database } from 'lucide-react';
import type { TurnStats as Stats } from '@cc-desk-tunnel/protocol';
import { useT } from './i18n.ts';
import { usePrefs } from './prefs.ts';
import { statFields, summaryText } from './turnStats.ts';
import { usePopover } from './usePopover.ts';

// The button under a reply: what the turn used and how fast the model was. Opens a card with the full figures.
export default function TurnStats({ stats }: { stats: Stats }) {
  const t = useT();
  const { stats: prefs } = usePrefs();
  const { open, setOpen, container, card } = usePopover();
  if (!prefs.enabled) return null;
  const rows = statFields.flatMap((field) => {
    const value = field.value(stats);
    return value == null ? [] : [{ field, value }];
  });
  const summary = summaryText(stats, prefs.summary);

  const total = rows.find(({ field }) => field.key === 'tokens');
  return (
    <div className="turn-stats" ref={container}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Database />
        {summary || t('session:stats.details')}
      </button>
      {open && (
        <div
          className="turn-stats-card"
          role="dialog"
          aria-label={t('session:stats.turn')}
          ref={card}
        >
          <header>
            <Database />
            <strong>{t('session:stats.turn')}</strong>
            {total && <b>{total.value}</b>}
          </header>
          <dl>
            {rows
              .filter((row) => row !== total)
              .map(({ field, value }) => (
                <div key={field.key}>
                  <dt>{field.label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
          </dl>
          {stats.partial && <p>{t('session:stats.partial')}</p>}
        </div>
      )}
    </div>
  );
}
