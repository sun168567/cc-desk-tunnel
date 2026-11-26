import { useState } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import type { Session } from '@cc-desk-tunnel/protocol';
import { Trans } from 'react-i18next';
import { useT } from './i18n.ts';
import { folderName } from './paths.ts';
import { isMac } from './platform.ts';
import { Modal } from './ui.tsx';

// The dialogs share the window's busy flag and error line, so a failed request stays visible in the open dialog.
type DialogProps = { busy: boolean; connected: boolean; error: string | null; close: () => void };

export function AddProjectDialog({
  busy,
  connected,
  error,
  close,
  add,
  title,
  action,
}: DialogProps & { add: (path: string) => void; title?: string; action?: string }) {
  const t = useT();
  title ??= t('session:project.addTitle');
  action ??= t('session:project.add');
  const [path, setPath] = useState('');
  return (
    <Modal
      title={title}
      onClose={() => {
        if (!busy) close();
      }}
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          add(path.trim());
        }}
      >
        <label>
          {t('session:project.path')}
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={isMac ? '/Users/me/projects/my-project' : 'D:\\projects\\my-project'}
            maxLength={2048}
            required
            spellCheck={false}
          />
        </label>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={close}>
            {t('common:cancel')}
          </button>
          <button className="button primary" disabled={busy || !connected}>
            <Plus />
            {action}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function DeleteSessionDialog({
  session,
  native,
  busy,
  connected,
  error,
  close,
  confirm,
}: DialogProps & {
  session: Session;
  native: boolean;
  confirm: () => void;
}) {
  const t = useT();
  return (
    <Modal
      title={t('session:delete.title')}
      onClose={() => {
        if (!busy) close();
      }}
    >
      <p className="delete-question">{t('session:delete.question', { title: session.title })}</p>
      <p className="muted">{native ? t('session:delete.native') : t('session:delete.plain')}</p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={close}>
          {t('common:cancel')}
        </button>
        <button
          type="button"
          className="button danger"
          disabled={busy || !connected}
          onClick={confirm}
        >
          <Trash2 />
          {t('session:delete.confirm')}
        </button>
      </div>
    </Modal>
  );
}

export function RenameSessionDialog({
  session,
  busy,
  connected,
  error,
  close,
  rename,
}: DialogProps & {
  session: Session;
  rename: (title: string) => void;
}) {
  const t = useT();
  const [title, setTitle] = useState(session.title);
  return (
    <Modal
      title={t('session:rename.title')}
      onClose={() => {
        if (!busy) close();
      }}
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          rename(title);
        }}
      >
        <label>
          {t('session:rename.name')}
          <input
            autoFocus
            maxLength={120}
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={close}>
            {t('common:cancel')}
          </button>
          <button className="button primary" disabled={busy || !connected}>
            <Check />
            {t('common:save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function RenameProjectDialog({
  path,
  name: current,
  busy,
  connected,
  error,
  close,
  rename,
}: DialogProps & {
  path: string;
  name: string;
  rename: (name: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState(current);
  return (
    <Modal
      title={t('session:project.renameTitle')}
      onClose={() => {
        if (!busy) close();
      }}
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          rename(name.trim());
        }}
      >
        <label>
          {t('session:project.displayName')}
          <input
            autoFocus
            maxLength={60}
            value={name}
            placeholder={folderName(path)}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <p className="muted">
          <Trans
            t={t}
            i18nKey="session:project.renameHint"
            values={{ path }}
            components={{ code: <code /> }}
          />
        </p>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={close}>
            {t('common:cancel')}
          </button>
          <button className="button primary" disabled={busy || !connected}>
            <Check />
            {t('common:save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
