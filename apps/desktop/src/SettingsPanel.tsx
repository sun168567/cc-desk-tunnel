import { useEffect, useState } from 'react';
import type { NativeSettings } from '@cc-desk-tunnel/protocol';
import { useT } from './i18n.ts';
import { cliSettingGroups } from './setting-fields.ts';
import type { CliField, CliKey, CliValue } from './setting-fields.ts';
import type { ProxyClient } from './client.ts';
import { Page, SettingText } from './ui.tsx';

// Edits the official CLI's user settings on the cloud host. Each change is saved at once; "默认" removes the
// key so the CLI's own default applies.
export default function SettingsPanel({ client }: { client: ProxyClient }) {
  const t = useT();
  const [values, setValues] = useState<NativeSettings | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Text being typed, by key; it is saved when the box is left.
  const [typed, setTyped] = useState<Partial<Record<CliKey, string>>>({});
  useEffect(() => {
    let current = true;
    client.fetch({ type: 'settings.get' }).then(
      (reply) => current && setValues(reply.values),
      (error: Error) => current && setFailure(error.message),
    );
    return () => {
      current = false;
    };
  }, [client]);
  async function save(change: Partial<NativeSettings>) {
    setFailure(null);
    setSaving(true);
    try {
      const reply = await client.fetch({ type: 'settings.update', values: change });
      setValues(reply.values);
      setTyped({});
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t('settings:saveFailed'));
    } finally {
      setSaving(false);
    }
  }
  function control(field: CliField, value: CliValue) {
    if (field.kind === 'text') {
      const saved = field.write(value);
      const text = typed[field.key] ?? saved;
      return (
        <input
          aria-label={field.title}
          disabled={saving}
          value={text}
          placeholder={field.placeholder}
          maxLength={200}
          spellCheck={false}
          onChange={(event) => setTyped({ ...typed, [field.key]: event.target.value })}
          onBlur={() => {
            if (field.write(field.read(text.trim())) !== saved)
              void save({ [field.key]: field.read(text.trim()) });
            else setTyped(({ [field.key]: _left, ...rest }) => rest);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      );
    }
    const options: [string, string][] =
      field.kind === 'toggle'
        ? [
            ['true', t('settings:on')],
            ['false', t('settings:off')],
          ]
        : field.options;
    return (
      <select
        aria-label={field.title}
        disabled={saving}
        value={value === null ? '' : String(value)}
        onChange={({ target }) =>
          void save({
            [field.key]: !target.value
              ? null
              : field.kind === 'toggle'
                ? target.value === 'true'
                : field.read(target.value),
          })
        }
      >
        <option value="">{field.unset}</option>
        {options.map(([option, name]) => (
          <option key={option} value={option}>
            {name}
          </option>
        ))}
      </select>
    );
  }
  return (
    <Page title={t('settings:section.claude.name')} intro={t('settings:cli.intro')}>
      {failure && (
        <p className="error-text" role="alert">
          {failure}
        </p>
      )}
      {values &&
        cliSettingGroups(t, values).map((group) => (
          <div key={group.name}>
            <h2 className="page-heading">{group.name}</h2>
            <div className="settings-list card">
              {group.fields.map((field) => (
                <label key={field.key}>
                  <SettingText title={field.title} detail={field.detail} help={field.help} />
                  {control(field, values[field.key])}
                </label>
              ))}
            </div>
          </div>
        ))}
    </Page>
  );
}
