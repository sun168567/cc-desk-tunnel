import { useEffect, useState } from 'react';
import { INSTRUCTIONS_LIMIT } from '@cc-desk-tunnel/protocol';
import { useT } from './i18n.ts';
import type { ProxyClient } from './client.ts';
import { Page } from './ui.tsx';

// The instructions every session on this service starts with: the user CLAUDE.md of the official CLI on the cloud
// host. A save goes through only over the version that was read, so a change made meanwhile in the terminal is not
// lost; the text being edited stays for the user to compare after reloading.
export default function GlobalInstructions({ client }: { client: ProxyClient }) {
  const t = useT();
  const [saved, setSaved] = useState<{ text: string; version: string } | null>(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  async function load() {
    setFailure(null);
    setStatus('');
    try {
      const { text, version } = await client.fetch({ type: 'instructions.get' });
      setSaved({ text, version });
      setText(text);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t('settings:instructions.readFailed'));
    }
  }
  useEffect(() => {
    void load();
  }, [client]);
  async function save() {
    if (!saved) return;
    setFailure(null);
    setStatus('');
    setSaving(true);
    try {
      const reply = await client.fetch({
        type: 'instructions.update',
        text,
        version: saved.version,
      });
      setSaved({ text: reply.text, version: reply.version });
      setText(reply.text);
      setStatus(t('settings:instructions.saved'));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t('settings:saveFailed'));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Page title={t('settings:section.instructions.name')} intro={t('settings:instructions.intro')}>
      <div className="card instructions-card">
        <textarea
          aria-label={t('settings:section.instructions.name')}
          className="instructions-editor"
          value={text}
          disabled={!saved || saving}
          maxLength={INSTRUCTIONS_LIMIT}
          spellCheck={false}
          rows={12}
          placeholder={t('settings:instructions.placeholder')}
          onChange={(event) => {
            setText(event.target.value);
            setStatus('');
          }}
        />
        {failure && (
          <p className="error-text" role="alert">
            {failure}
          </p>
        )}
        <div className="setting-actions">
          <span className="muted" role="status">
            {status}
          </span>
          <button type="button" className="button" disabled={saving} onClick={() => void load()}>
            {t('settings:instructions.reload')}
          </button>
          <button
            type="button"
            className="button primary"
            disabled={!saved || saving || text === saved.text}
            onClick={() => void save()}
          >
            {t('common:save')}
          </button>
        </div>
      </div>
    </Page>
  );
}
