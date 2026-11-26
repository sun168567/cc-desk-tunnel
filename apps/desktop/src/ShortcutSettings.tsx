import { useState } from 'react';
import { useT } from './i18n.ts';
import { setPrefs, usePrefs } from './prefs.ts';
import { actionName, actions, comboOf, keyFor, show, usable } from './shortcuts.ts';
import type { Action } from './shortcuts.ts';
import { Page, Switch } from './ui.tsx';

export default function ShortcutSettings() {
  const t = useT();
  const prefs = usePrefs();
  const { enabled } = prefs.shortcuts;
  // The action whose next key press becomes its shortcut.
  const [recording, setRecording] = useState<Action | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const set = (action: Action, combo: string) =>
    setPrefs((value) => ({
      ...value,
      shortcuts: { ...value.shortcuts, keys: { ...value.shortcuts.keys, [action]: combo } },
    }));
  const stop = () => {
    setRecording(null);
    setFailure(null);
  };
  const listed = actions.filter((action) => !action.desktop || window.desktop);
  return (
    <Page title={t('settings:section.shortcuts.name')} intro={t('settings:shortcut.intro')}>
      <div className="card">
        <div className="setting-row">
          <span>
            <strong>{t('settings:shortcut.enabled')}</strong>
            <small>{t('settings:shortcut.enabledDetail')}</small>
          </span>
          <Switch
            label={t('settings:shortcut.enabled')}
            checked={enabled}
            onChange={(value) => {
              stop();
              setPrefs((current) => ({
                ...current,
                shortcuts: { ...current.shortcuts, enabled: value },
              }));
            }}
          />
        </div>
      </div>
      <h2 className="page-heading">{t('settings:shortcut.heading')}</h2>
      <p className="muted">{t('settings:shortcut.howTo')}</p>
      {failure && (
        <p className="error-text" role="alert">
          {failure}
        </p>
      )}
      <div className="card">
        {listed.map(({ id }) => {
          const combo = keyFor(prefs, id);
          const name = actionName(t, id);
          return (
            <div className="setting-row" key={id}>
              <span>
                <strong>{name}</strong>
              </span>
              <button
                type="button"
                className={`key-button ${recording === id ? 'recording' : ''}`}
                aria-label={t('settings:shortcut.change', { name })}
                disabled={!enabled}
                onClick={() => {
                  setFailure(null);
                  setRecording(recording === id ? null : id);
                }}
                onBlur={() => recording === id && stop()}
                onKeyDown={(event) => {
                  if (recording !== id || event.key === 'Tab') return;
                  // The press is this box's alone: it must not run the shortcut it may already be.
                  event.preventDefault();
                  if (event.key === 'Escape') return stop();
                  if (event.key === 'Backspace' || event.key === 'Delete') {
                    set(id, '');
                    return stop();
                  }
                  const pressed = comboOf(event);
                  if (!pressed) return;
                  if (!usable(pressed))
                    return setFailure(t('settings:shortcut.typing', { combo: show(t, pressed) }));
                  const taken = listed.find(
                    (other) => other.id !== id && keyFor(prefs, other.id) === pressed,
                  );
                  if (taken)
                    return setFailure(
                      t('settings:shortcut.taken', {
                        combo: show(t, pressed),
                        name: actionName(t, taken.id),
                      }),
                    );
                  set(id, pressed);
                  stop();
                }}
              >
                {recording === id
                  ? t('settings:shortcut.recording')
                  : combo
                    ? show(t, combo)
                    : t('settings:shortcut.unset')}
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="button"
        onClick={() => {
          stop();
          setPrefs((value) => ({ ...value, shortcuts: { ...value.shortcuts, keys: {} } }));
        }}
      >
        {t('settings:shortcut.reset')}
      </button>
    </Page>
  );
}
