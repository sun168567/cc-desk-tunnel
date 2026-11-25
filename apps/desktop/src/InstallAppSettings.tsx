import { useState } from 'react';
import { webAppBadgeSchema, webAppNameSchema } from '@cc-desk-tunnel/protocol';
import { useT } from './i18n.ts';
import { Page, Row, Switch } from './ui.tsx';

type Settings = { name: string; label: string; badge: boolean };
const defaultName = 'CC Desk Tunnel';
const storageKey = `web-app:${new URL('./', location.href).pathname}`;
function read(): Settings {
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}') ?? {};
  } catch {}
  const query = new URLSearchParams(location.search);
  const storedName = webAppNameSchema.safeParse(saved.name).data;
  const one = (key: string) => {
    const values = query.getAll(key);
    return values.length === 1 ? values[0] : undefined;
  };
  const label = webAppBadgeSchema.safeParse(storedName ? saved.label : one('appLabel')).data ?? '';
  return {
    name: storedName ?? webAppNameSchema.safeParse(one('appName')).data ?? defaultName,
    label,
    badge: storedName && typeof saved.badge === 'boolean' ? saved.badge : !!label,
  };
}
function apply(value: Settings) {
  const query = new URLSearchParams({ appName: value.name });
  if (value.badge && value.label) query.set('appLabel', value.label);
  const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (manifest) manifest.href = `./manifest.webmanifest?${query}`;
  document.title = value.name;
  let apple = document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]');
  if (!apple) {
    apple = document.createElement('meta');
    apple.name = 'apple-mobile-web-app-title';
    document.head.append(apple);
  }
  apple.content = value.name;
  return query;
}
// Restore before login as installation is also available from the browser's own menu.
if (!window.desktop) apply(read());

const limitLabel = (value: string) =>
  Array.from(new Intl.Segmenter().segment(value), ({ segment }) => segment)
    .slice(0, 3)
    .join('');

export default function InstallAppSettings() {
  const t = useT();
  const [value, setValue] = useState(read);
  const [error, setError] = useState('');
  function change(fields: Partial<Settings>, composing = false) {
    const next = { ...value, ...fields };
    setValue(next);
    setError('');
    if (composing) return;
    const parsedName = webAppNameSchema.safeParse(next.name.trim() || defaultName);
    const parsedLabel = webAppBadgeSchema.safeParse(next.label);
    if (!parsedName.success) return setError(t('settings:install.nameInvalid'));
    if (next.badge && next.label.trim() && !parsedLabel.success)
      return setError(t('settings:install.badgeInvalid'));
    const settings = { ...next, name: parsedName.data, label: parsedLabel.data ?? '' };
    try {
      localStorage.setItem(storageKey, JSON.stringify(settings));
      const url = new URL('./', location.href);
      url.search = apply(settings).toString();
      url.hash = location.hash === '#install' ? '' : location.hash;
      history.replaceState(history.state, '', url);
    } catch {
      setError(t('settings:install.saveFailed'));
    }
  }
  return (
    <Page title={t('settings:section.install.name')} intro={t('settings:install.intro')}>
      <div className="card">
        <Row title={t('settings:install.name')}>
          <input
            className="setting-name"
            aria-label={t('settings:install.name')}
            maxLength={40}
            placeholder={defaultName}
            value={value.name}
            onChange={(event) =>
              change({ name: event.target.value }, (event.nativeEvent as InputEvent).isComposing)
            }
            onCompositionEnd={(event) => change({ name: event.currentTarget.value })}
          />
        </Row>
        <Row title={t('settings:install.badge')}>
          <Switch
            label={t('settings:install.badge')}
            checked={value.badge}
            onChange={(badge) => change({ badge })}
          />
        </Row>
        {value.badge && (
          <Row title={t('settings:install.badgeText')}>
            <input
              className="setting-name"
              aria-label={t('settings:install.badgeText')}
              placeholder={t('settings:install.badgeHint')}
              value={value.label}
              onChange={(event) => {
                const composing = (event.nativeEvent as InputEvent).isComposing;
                change(
                  { label: composing ? event.target.value : limitLabel(event.target.value) },
                  composing,
                );
              }}
              onCompositionEnd={(event) => change({ label: limitLabel(event.currentTarget.value) })}
            />
          </Row>
        )}
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </Page>
  );
}
