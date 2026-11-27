import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, Trash2 } from 'lucide-react';
import { pluginEvents } from '@cc-desk-tunnel/protocol';
import type {
  Plugin,
  PluginEvent,
  PluginOption,
  PluginRun,
  PluginValue,
} from '@cc-desk-tunnel/protocol';
import { wordsText } from '@cc-desk-tunnel/i18n';
import type { ProxyClient } from './client.ts';
import { localeOf, type T, useT } from './i18n.ts';
import { IconButton, Page, Row, SettingText, Switch } from './ui.tsx';

const failureOf = (t: T, error: unknown) =>
  error instanceof Error ? error.message : t('settings:saveFailed');
// An event as the page names it: one of the service's in the window's words, another as the plugin wrote it.
const eventName = (t: T, name: string) =>
  (pluginEvents as readonly string[]).includes(name)
    ? t(`settings:plugins.event.${name as PluginEvent}`)
    : name;
const timeOf = (t: T, at: string) => new Date(at).toLocaleString(localeOf(t));

// The service's plugins (see docs/plugins.md), each a card that opens to its settings, its trial and its log. A
// plugin draws nothing of its own: its settings are the options it declares, drawn here.
export default function PluginSettings({
  client,
  plugins,
}: {
  client: ProxyClient;
  plugins: Plugin[];
}) {
  const t = useT();
  const [shown, setShown] = useState<string>();
  return (
    <Page title={t('settings:section.plugins.name')} intro={t('settings:scope.everyDevice')}>
      <p className="muted page-section-note">{t('settings:plugins.intro')}</p>
      {plugins.length ? (
        <div className="plugin-list">
          {plugins.map((plugin) => (
            <PluginCard
              key={plugin.id}
              client={client}
              plugin={plugin}
              open={shown === plugin.id}
              toggle={() => setShown(shown === plugin.id ? undefined : plugin.id)}
            />
          ))}
        </div>
      ) : (
        <p className="muted">{t('settings:plugins.empty')}</p>
      )}
    </Page>
  );
}

function PluginCard({
  client,
  plugin,
  open,
  toggle,
}: {
  client: ProxyClient;
  plugin: Plugin;
  open: boolean;
  toggle: () => void;
}) {
  const t = useT();
  const [failure, setFailure] = useState<string | null>(null);
  const { id, title } = plugin;
  const trouble = plugin.problem
    ? wordsText(t, plugin.problem)
    : plugin.failure && t('settings:plugins.failed', { time: timeOf(t, plugin.failure.at) });
  const facts = [
    plugin.version && t('settings:plugins.version', { version: plugin.version }),
    plugin.author && t('settings:plugins.author', { name: plugin.author.name }),
  ]
    .filter(Boolean)
    .join(' · ');
  async function enable(enabled: boolean) {
    setFailure(null);
    try {
      await client.request({ type: 'plugin.enable', id, enabled });
    } catch (error) {
      setFailure(failureOf(t, error));
    }
  }
  return (
    <section className="plugin card" aria-label={title}>
      <div className="setting-row plugin-head">
        <button
          type="button"
          className="plugin-open"
          aria-expanded={open}
          title={open ? t('settings:plugins.hide') : t('settings:plugins.show')}
          onClick={toggle}
        >
          {open ? <ChevronDown /> : <ChevronRight />}
          <span>
            <strong>{title}</strong>
            {plugin.description && <small>{plugin.description}</small>}
            {facts && <small>{facts}</small>}
            {trouble && <small className="plugin-trouble">{trouble}</small>}
          </span>
        </button>
        <Switch
          label={t('settings:plugins.enable', { title })}
          checked={plugin.enabled}
          onChange={(enabled) => void enable(enabled)}
        />
      </div>
      {failure && (
        <p className="error-text" role="alert">
          {failure}
        </p>
      )}
      {open && <PluginDetails client={client} plugin={plugin} />}
    </section>
  );
}

function PluginDetails({ client, plugin }: { client: ProxyClient; plugin: Plugin }) {
  const t = useT();
  const { id } = plugin;
  const [runs, setRuns] = useState<PluginRun[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [trying, setTrying] = useState<string>();
  async function load(clear = false) {
    setFailure(null);
    try {
      setRuns((await client.fetch({ type: 'plugin.log', id, ...(clear && { clear: true }) })).runs);
    } catch (error) {
      setFailure(failureOf(t, error));
    }
  }
  useEffect(() => {
    let current = true;
    client.fetch({ type: 'plugin.log', id }).then(
      (reply) => current && setRuns(reply.runs),
      (error: Error) => current && setFailure(error.message),
    );
    return () => {
      current = false;
    };
  }, [client, id]);
  async function attempt(event: string) {
    setTrying(event);
    setFailure(null);
    try {
      await client.fetch({ type: 'plugin.try', id, event });
      await load();
    } catch (error) {
      setFailure(failureOf(t, error));
    } finally {
      setTrying(undefined);
    }
  }
  async function save(key: string, value: PluginValue | null) {
    await client.request({ type: 'plugin.configure', id, values: { [key]: value } });
  }
  const options = Object.entries(plugin.options);
  return (
    <div className="plugin-body">
      {failure && (
        <p className="error-text" role="alert">
          {failure}
        </p>
      )}
      {options.length > 0 && (
        <>
          <h3 className="plugin-heading">{t('settings:plugins.settings')}</h3>
          <div className="settings-list">
            {options.map(([key, option]) => (
              <OptionField
                // Drawn anew when the service holds another value, as after another window changed it.
                key={`${key}:${String(plugin.values[key])}:${plugin.secrets.includes(key)}`}
                option={option}
                value={plugin.values[key]}
                secret={plugin.secrets.includes(key)}
                save={(value) => save(key, value)}
              />
            ))}
          </div>
        </>
      )}
      {plugin.events.length > 0 && (
        <>
          <h3 className="plugin-heading">{t('settings:plugins.try.heading')}</h3>
          <p className="muted plugin-note">{t('settings:plugins.try.intro')}</p>
          <div className="plugin-events">
            {plugin.events.map((event) => (
              <button
                key={event}
                type="button"
                className="button secondary"
                disabled={trying !== undefined}
                onClick={() => void attempt(event)}
              >
                {trying === event ? t('settings:plugins.try.running') : eventName(t, event)}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="plugin-log-head">
        <h3 className="plugin-heading">{t('settings:plugins.log.heading')}</h3>
        <IconButton title={t('settings:plugins.log.refresh')} onClick={() => void load()}>
          <RefreshCw />
        </IconButton>
        <IconButton
          title={t('settings:plugins.log.clear')}
          disabled={!runs?.length}
          onClick={() => void load(true)}
        >
          <Trash2 />
        </IconButton>
      </div>
      {runs && !runs.length && (
        <p className="muted plugin-note">{t('settings:plugins.log.empty')}</p>
      )}
      {runs && runs.length > 0 && (
        <ul className="plugin-log">
          {[...runs].reverse().map((run, index) => (
            <li key={`${run.at}:${index}`}>
              <div className="plugin-log-line">
                <span className="muted">{timeOf(t, run.at)}</span>
                <span>{eventName(t, run.event)}</span>
                {run.trial && <span className="badge">{t('settings:plugins.log.trial')}</span>}
                <span className={run.result === 'ok' ? 'plugin-ok' : 'plugin-bad'}>
                  {run.result === 'failed' && run.exitCode !== undefined
                    ? t('settings:plugins.log.result.failedCode', { code: run.exitCode })
                    : t(`settings:plugins.log.result.${run.result}`)}
                </span>
                <span className="muted">{t('settings:plugins.log.ms', { ms: run.ms })}</span>
              </div>
              {run.output && <pre>{run.output}</pre>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// One option as the plugin declared it: a switch, a list to pick from, or a box of text or a number. A choice is
// saved at once, text when the box is left or Enter pressed; a secret is never shown, and an empty box keeps it.
function OptionField({
  option,
  value,
  secret,
  save,
}: {
  option: PluginOption;
  value: PluginValue | undefined;
  secret: boolean;
  save: (value: PluginValue | null) => Promise<void>;
}) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const shown = option.sensitive || value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(shown);
  async function commit(next: PluginValue | null) {
    try {
      await save(next);
      setError(null);
      if (option.sensitive) setDraft('');
    } catch (failure) {
      setError(failureOf(t, failure));
    }
  }
  const said = error && <small className="error-text">{error}</small>;
  if (option.type === 'boolean')
    return (
      <Row title={option.title} detail={error ?? option.description}>
        <Switch
          label={option.title}
          checked={Boolean(value ?? option.default ?? false)}
          onChange={(checked) => void commit(checked)}
        />
      </Row>
    );
  if (option.options) {
    const current = String(value ?? option.default ?? '');
    return (
      <label>
        <SettingText title={option.title} detail={option.description} />
        <span className="plugin-input">
          <select
            aria-label={option.title}
            value={current}
            onChange={({ target }) => void commit(target.value === '' ? null : target.value)}
          >
            {(current === '' || (!option.required && option.default === undefined)) && (
              <option value="">{t('settings:plugins.unset')}</option>
            )}
            {option.options.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
          {said}
        </span>
      </label>
    );
  }
  const leave = () => {
    if (draft === shown) return;
    if (option.type === 'number') void commit(draft.trim() === '' ? null : Number(draft));
    else void commit(draft === '' && !option.sensitive ? null : draft);
  };
  return (
    <label>
      <SettingText title={option.title} detail={option.description} />
      <span className="plugin-input">
        <span className="plugin-input-line">
          <input
            aria-label={option.title}
            type={option.sensitive ? 'password' : option.type === 'number' ? 'number' : 'text'}
            autoComplete="off"
            value={draft}
            min={option.min}
            max={option.max}
            placeholder={
              secret
                ? t('settings:plugins.secretSet')
                : option.default !== undefined
                  ? String(option.default)
                  : t('settings:plugins.unset')
            }
            onChange={({ target }) => setDraft(target.value)}
            onBlur={leave}
            onKeyDown={(event) => event.key === 'Enter' && leave()}
          />
          {secret && (
            <button type="button" className="button secondary" onClick={() => void commit(null)}>
              {t('settings:plugins.clearValue')}
            </button>
          )}
        </span>
        {said}
      </span>
    </label>
  );
}
