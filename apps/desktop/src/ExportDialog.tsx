import { useState } from 'react';
import type { Session } from '@cc-desk-tunnel/protocol';
import { useT } from './i18n.ts';
import { Modal } from './ui.tsx';
import type { ExportOptions } from './exportSession.ts';

const KEY = 'export-options';
const CONTENTS = ['answers', 'said', 'all'] as const;
// The choices made last time, for the next export.
function remembered(): ExportOptions {
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) ?? '') as Partial<ExportOptions>;
    if (CONTENTS.includes(kept.content!))
      return {
        content: kept.content!,
        ...(Number.isInteger(kept.turns) && kept.turns! > 0 ? { turns: kept.turns } : {}),
      };
  } catch {
    // Nothing kept, or something unreadable: the whole session, every step.
  }
  return { content: 'all' };
}

// What to put in a session's Markdown export: every step or only what was said, of every turn or of the last few.
export default function ExportDialog({
  session,
  save,
  close,
}: {
  session: Session;
  save: (options: ExportOptions) => Promise<void>;
  close: () => void;
}) {
  const t = useT();
  const [options, setOptions] = useState(remembered);
  const [count, setCount] = useState(options.turns ?? 20);
  const [reading, setReading] = useState(false);
  return (
    <Modal title={t('session:exportDialog.title')} onClose={close} help="sessions#export">
      <div className="dialog-form export-dialog">
        <p className="muted">{session.title}</p>
        <div className="export-field">
          <span>{t('session:exportDialog.content')}</span>
          <div className="segmented" role="group" aria-label={t('session:exportDialog.content')}>
            {CONTENTS.map((content) => (
              <button
                type="button"
                key={content}
                aria-pressed={options.content === content}
                onClick={() => setOptions({ ...options, content })}
              >
                {t(`session:exportDialog.${content}.label`)}
              </button>
            ))}
          </div>
          <small className="muted">{t(`session:exportDialog.${options.content}.detail`)}</small>
        </div>
        <div className="export-field">
          <span>{t('session:exportDialog.range')}</span>
          <div className="export-range">
            <div className="segmented" role="group" aria-label={t('session:exportDialog.range')}>
              <button
                type="button"
                aria-pressed={!options.turns}
                onClick={() => setOptions({ content: options.content })}
              >
                {t('session:exportDialog.every')}
              </button>
              <button
                type="button"
                aria-pressed={!!options.turns}
                onClick={() => setOptions({ ...options, turns: count })}
              >
                {t('session:exportDialog.recent')}
              </button>
            </div>
            {!!options.turns && (
              <label>
                <input
                  type="number"
                  min={1}
                  max={9999}
                  value={count}
                  aria-label={t('session:exportDialog.turns')}
                  onChange={(event) => {
                    const value = Math.max(
                      1,
                      Math.min(9999, Math.floor(Number(event.target.value) || 1)),
                    );
                    setCount(value);
                    setOptions({ ...options, turns: value });
                  }}
                />
                {t('session:exportDialog.turnsUnit')}
              </label>
            )}
          </div>
        </div>
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={close}>
            {t('common:cancel')}
          </button>
          <button
            type="button"
            className="button primary"
            disabled={reading}
            onClick={async () => {
              localStorage.setItem(KEY, JSON.stringify(options));
              setReading(true);
              try {
                await save(options);
              } finally {
                close();
              }
            }}
          >
            {reading ? t('session:exportDialog.reading') : t('session:exportDialog.save')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
