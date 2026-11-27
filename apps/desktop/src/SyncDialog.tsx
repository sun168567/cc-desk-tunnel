import { useEffect, useState } from 'react';
import { useT } from './i18n.ts';
import { copyText } from './copy.tsx';
import { Modal } from './ui.tsx';
import { compare, copy } from './instructionsSync.ts';
import type { Comparison, Side } from './instructionsSync.ts';

// Copies a project's instructions and skills between the computer and the service (see instructionsSync.ts): what is
// new is copied, what differs is replaced only when asked, or handed to Claude to merge.
export default function SyncDialog({
  name,
  computerName,
  sides,
  close,
}: {
  // The project's name, and that of the computer it is on.
  name: string;
  computerName: string;
  sides: { computer: Side; server: Side };
  close: () => void;
}) {
  const t = useT();
  const [up, setUp] = useState(true);
  const [found, setFound] = useState<Comparison | null>(null);
  const [replace, setReplace] = useState(false);
  const [state, setState] = useState<'comparing' | 'ready' | 'copying' | 'done' | 'failed'>(
    'comparing',
  );
  const [message, setMessage] = useState('');
  const from = up ? sides.computer : sides.server;
  const to = up ? sides.server : sides.computer;
  const files = window.desktop!.files;
  useEffect(() => {
    let live = true;
    setState('comparing');
    setFound(null);
    setReplace(false);
    compare(files, from, to).then(
      (result) => {
        if (!live) return;
        setFound(result);
        setState('ready');
      },
      (error: Error) => {
        if (!live) return;
        setMessage(error.message);
        setState('failed');
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [up]);
  const paths = found ? [...found.added, ...(replace ? found.differ : [])] : [];
  const listed = (names: string[]) =>
    names.length > 6
      ? `${names.slice(0, 6).join(t('session:sync.separator'))} ${t('session:sync.more', { count: names.length - 6 })}`
      : names.join(t('session:sync.separator'));
  async function run() {
    setState('copying');
    try {
      const count = await copy(files, from, to, paths, replace);
      setMessage(t('session:sync.done', { count }));
      setState('done');
    } catch (error) {
      setMessage((error as Error).message);
      setState('failed');
    }
  }
  const where = (side: Side) =>
    side === sides.server
      ? t('session:sync.server', { path: side.root })
      : `${computerName} · ${side.root}`;
  return (
    <Modal title={t('session:sync.title', { name })} onClose={close}>
      <div className="dialog-form sync-dialog">
        <p className="muted">{t('session:sync.intro')}</p>
        <div className="segmented" role="group" aria-label={t('session:sync.direction')}>
          <button
            type="button"
            aria-pressed={up}
            disabled={state === 'copying'}
            onClick={() => setUp(true)}
          >
            {t('session:sync.up')}
          </button>
          <button
            type="button"
            aria-pressed={!up}
            disabled={state === 'copying'}
            onClick={() => setUp(false)}
          >
            {t('session:sync.down')}
          </button>
        </div>
        <p className="sync-route muted">
          {where(from)} → {where(to)}
        </p>
        {state === 'comparing' && <p role="status">{t('session:sync.comparing')}</p>}
        {found && state !== 'comparing' && (
          <ul className="sync-found">
            {!found.added.length && !found.differ.length && !found.same.length && (
              <li>{t('session:sync.none')}</li>
            )}
            {found.added.length > 0 && (
              <li>
                <strong>{t('session:sync.added', { count: found.added.length })}</strong>
                <span>{listed(found.added)}</span>
              </li>
            )}
            {found.differ.length > 0 && (
              <li>
                <strong>{t('session:sync.differ', { count: found.differ.length })}</strong>
                <span>{listed(found.differ)}</span>
              </li>
            )}
            {found.same.length > 0 && (
              <li>
                <strong>{t('session:sync.same', { count: found.same.length })}</strong>
              </li>
            )}
          </ul>
        )}
        {found && found.differ.length > 0 && state === 'ready' && (
          <label className="check-row">
            <input
              type="checkbox"
              checked={replace}
              onChange={(event) => setReplace(event.target.checked)}
            />
            {t('session:sync.replace', { count: found.differ.length })}
          </label>
        )}
        {message && (
          <p className={state === 'failed' ? 'error-text' : 'muted'} role="status">
            {message}
          </p>
        )}
        <div className="dialog-actions">
          {found && found.differ.length > 0 && state !== 'done' && (
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                void copyText(
                  t('session:sync.mergePrompt', {
                    computer: `${computerName} · ${sides.computer.root}`,
                    server: sides.server.root,
                    files: found.differ.map((path) => `- ${path}`).join('\n'),
                  }),
                ).then(() => setMessage(t('session:sync.copied')));
              }}
            >
              {t('session:sync.merge')}
            </button>
          )}
          <button type="button" className="button secondary" onClick={close}>
            {state === 'done' ? t('common:close') : t('common:cancel')}
          </button>
          {state !== 'done' && (
            <button
              type="button"
              className="button primary"
              disabled={state !== 'ready' || !paths.length}
              onClick={() => void run()}
            >
              {state === 'copying'
                ? t('session:sync.copying')
                : t('session:sync.run', { count: paths.length })}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
