import type { SetupTokenResult } from '@cc-desk-tunnel/protocol';
import { wordsText } from '@cc-desk-tunnel/i18n';
import { useT } from './i18n.ts';
import { CopyButton } from './copy.tsx';
import { Modal } from './ui.tsx';

export function SetupTokenDialog({
  result,
  close,
}: {
  result: SetupTokenResult;
  close: () => void;
}) {
  const t = useT();
  return (
    <Modal title={t('account:token.title')} onClose={close}>
      <div className="dialog-form">
        <p>{result.saved ? t('account:token.saved') : t('account:token.unsaved')}</p>
        {result.error && (
          <p className="error-text" role="alert">
            {wordsText(t, result.error)}
          </p>
        )}
        <p className="muted">{t('account:token.once')}</p>
        <textarea
          className="setup-token-value"
          aria-label={t('account:token.label')}
          value={result.token}
          readOnly
          rows={4}
          spellCheck={false}
        />
        <div className="dialog-actions">
          <CopyButton text={result.token} label={t('account:token.copy')} />
          <button type="button" className="button primary" onClick={close}>
            {t('account:token.close')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
