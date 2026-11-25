import { useEffect, useState } from 'react';
import type { IdleCompaction } from '@cc-desk-tunnel/protocol';
import { useT } from './i18n.ts';
import type { ProxyClient } from './client.ts';
import { idleCompactionFields } from './setting-fields.ts';
import { Row, SettingText, SettingsHeading, Switch } from './ui.tsx';

// The service's own setting, kept with its sessions and not in the CLI's file: before an idle session's one-hour prompt
// cache lapses, the service compacts it as the compact button does. Each change is saved at once.
export default function IdleCompactionSettings({ client }: { client: ProxyClient }) {
  const t = useT();
  const fields = idleCompactionFields(t);
  const [values, setValues] = useState<IdleCompaction | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let current = true;
    client.fetch({ type: 'compaction.get' }).then(
      (reply) => current && setValues(reply.values),
      (error: Error) => current && setFailure(error.message),
    );
    return () => {
      current = false;
    };
  }, [client]);
  async function save(change: Partial<IdleCompaction>) {
    setFailure(null);
    setSaving(true);
    try {
      setValues((await client.fetch({ type: 'compaction.update', values: change })).values);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t('settings:saveFailed'));
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <SettingsHeading help="context#idle">{t('settings:idle.heading')}</SettingsHeading>
      <p className="muted page-section-note">{t('settings:idle.intro')}</p>
      {failure && (
        <p className="error-text" role="alert">
          {failure}
        </p>
      )}
      {values && (
        <div className="settings-list card">
          <Row title={fields.enabled.title} detail={fields.enabled.detail}>
            <Switch
              label={fields.enabled.title}
              checked={values.enabled}
              disabled={saving}
              onChange={(enabled) => void save({ enabled })}
            />
          </Row>
          <label>
            <SettingText title={fields.afterMinutes.title} detail={fields.afterMinutes.detail} />
            <select
              aria-label={fields.afterMinutes.title}
              disabled={saving}
              value={String(values.afterMinutes)}
              onChange={({ target }) => void save({ afterMinutes: Number(target.value) })}
            >
              {[...new Set([...fields.afterMinutes.options, values.afterMinutes])]
                .sort((a, b) => a - b)
                .map((value) => (
                  <option key={value} value={value}>
                    {t('settings:idle.minutes', { count: value })}
                  </option>
                ))}
            </select>
          </label>
          <label>
            <SettingText title={fields.minTokens.title} detail={fields.minTokens.detail} />
            <select
              aria-label={fields.minTokens.title}
              disabled={saving}
              value={String(values.minTokens)}
              onChange={({ target }) => void save({ minTokens: Number(target.value) })}
            >
              {[...new Set([...fields.minTokens.options, values.minTokens])]
                .sort((a, b) => a - b)
                .map((value) => (
                  <option key={value} value={value}>
                    {value / 1000}K tokens
                  </option>
                ))}
            </select>
          </label>
        </div>
      )}
    </>
  );
}
