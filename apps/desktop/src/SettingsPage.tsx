import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { platformOf } from '@cc-desk-tunnel/protocol';
import type { Plugin } from '@cc-desk-tunnel/protocol';
import { languageChoices, languageNames } from '@cc-desk-tunnel/i18n';
import {
  ArrowLeft,
  Bell,
  Cable,
  FileText,
  Globe,
  Hourglass,
  Info,
  Keyboard,
  LogOut,
  Palette,
  Plug,
  Search,
  Settings,
  SlidersHorizontal,
  Smartphone,
  SquareTerminal,
  UserRound,
} from 'lucide-react';
import { type T, useT } from './i18n.ts';
import type { ConnectedDevice, ProxyClient } from './client.ts';
import WebAccessSettings from './WebAccessSettings.tsx';
import InstallAppSettings from './InstallAppSettings.tsx';
import type { ConnectionForm } from './LoginPage.tsx';
import { connectionWaits, setPrefs, themes, usePrefs, waitRange } from './prefs.ts';
import { viewModes } from './transcriptView.ts';
import type { NotifyKind } from './prefs.ts';
import { waitFields } from './setting-fields.ts';
import { inSummary, sampleStats, statFields, summaryText } from './turnStats.ts';
import { barText, inBar, sampleSession, sessionFields } from './sessionStats.ts';
import { GithubMark, openProject, project } from './project.tsx';
import { selfUpdating } from './platform.ts';
import GlobalInstructions from './GlobalInstructions.tsx';
import IdleCompactionSettings from './IdleCompactionSettings.tsx';
import PluginSettings from './PluginSettings.tsx';
import SettingsPanel from './SettingsPanel.tsx';
import { useShared } from './shared.ts';
import type { Account } from './shared.ts';
import ShellSettings from './ShellSettings.tsx';
import ShortcutSettings from './ShortcutSettings.tsx';
import HelpLink from './HelpLink.tsx';
import { IconButton, Page, PageHelp, Row, SettingsHeading, Switch } from './ui.tsx';
import type { MenuItem } from './ui.tsx';

export type Section =
  | 'general'
  | 'appearance'
  | 'connection'
  | 'notifications'
  | 'shortcuts'
  | 'context'
  | 'shell'
  | 'web'
  | 'plugins'
  | 'account'
  | 'claude'
  | 'instructions'
  | 'install'
  | 'about';
// The groups say where their settings are kept and what they apply to: this computer, the service (for every device
// connected to it), or Claude Code's own files on the cloud host. A page's name and its `words`, what the search box
// matches besides the name (the settings found inside), are in the catalogs (settings:section.<id>).
type Group = 'local' | 'server' | 'claude' | 'other';
export const sections: { id: Section; group: Group; icon: typeof Bell }[] = [
  { id: 'general', group: 'local', icon: Settings },
  { id: 'appearance', group: 'local', icon: Palette },
  { id: 'connection', group: 'local', icon: Cable },
  { id: 'notifications', group: 'local', icon: Bell },
  { id: 'shortcuts', group: 'local', icon: Keyboard },
  { id: 'context', group: 'server', icon: Hourglass },
  { id: 'shell', group: 'server', icon: SquareTerminal },
  { id: 'web', group: 'server', icon: Globe },
  { id: 'plugins', group: 'server', icon: Plug },
  { id: 'account', group: 'claude', icon: UserRound },
  { id: 'claude', group: 'claude', icon: SlidersHorizontal },
  { id: 'instructions', group: 'claude', icon: FileText },
  { id: 'install', group: 'other', icon: Smartphone },
  { id: 'about', group: 'other', icon: Info },
];
export const sectionName = (t: T, id: Section) => t(`settings:section.${id}.name`);
const sectionWords = (t: T, id: Section) => t(`settings:section.${id}.words`);
// The heading of the settings guide (help-content.ts) that tells about a page.
// The help each settings page's "?" opens: the article on what its settings are for.
const pageHelp: Partial<Record<Section, string>> = {
  connection: 'execution#waits',
  notifications: 'background',
  shortcuts: 'conversation',
  context: 'context',
  shell: 'execution#shell',
  web: 'browser',
  account: 'quota',
  claude: 'settings#cli',
  instructions: 'memory',
  about: 'upgrade',
};
// What a page's settings apply to, said under its title: kept in this browser or on this computer, or on the service
// for every device or for this one (settings:scope.*).
const localScope = (t: T, browser: boolean) =>
  t(browser ? 'settings:scope.browser' : 'settings:scope.local');
// The events that may raise a notification, each with what it is (settings:notify.<kind>).
const kinds: NotifyKind[] = ['done', 'failed', 'approval', 'question', 'schedule', 'connection'];

// The language of this computer's windows, a choice of the computer like the colours. A language is named in
// itself, as lists of languages do, so that it is found whatever language the window is in.
function LanguageSettings() {
  const { language } = usePrefs();
  const t = useT();
  return (
    <>
      <h2 className="page-heading">{t('language.title')}</h2>
      <div className="card">
        <div className="setting-row stat-picks">
          <span>
            <strong>{t('language.title')}</strong>
            <small>{t('language.detail')}</small>
          </span>
          <div className="stat-chips" role="radiogroup" aria-label={t('language.title')}>
            {languageChoices.map((choice) => (
              <button
                type="button"
                key={choice}
                role="radio"
                className="stat-chip"
                lang={choice === 'system' ? undefined : choice}
                aria-checked={choice === language}
                onClick={() => setPrefs((prefs) => ({ ...prefs, language: choice }))}
              >
                {choice === 'system' ? t('language.system') : languageNames[choice]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

// How much of the work behind a reply is shown is a choice of this computer's window too.
function ThemeSettings() {
  const t = useT();
  const { theme } = usePrefs();
  return (
    <>
      <h2 className="page-heading">{t('settings:theme.heading')}</h2>
      <div className="card">
        <div className="setting-row stat-picks">
          <span>
            <strong>{t('settings:theme.heading')}</strong>
            <small>{t('settings:theme.detail')}</small>
          </span>
          <div className="stat-chips" role="radiogroup" aria-label={t('settings:theme.heading')}>
            {themes.map((entry) => (
              <button
                type="button"
                key={entry}
                role="radio"
                className="stat-chip"
                aria-checked={entry === theme}
                onClick={() => setPrefs((prefs) => ({ ...prefs, theme: entry }))}
              >
                {t(`settings:theme.${entry}`)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function TranscriptViewSettings() {
  const t = useT();
  const { view } = usePrefs();
  const set = (values: Partial<typeof view>) =>
    setPrefs((prefs) => ({ ...prefs, view: { ...prefs.view, ...values } }));
  const current = viewModes.find((mode) => mode === view.mode) ?? viewModes[0];
  return (
    <>
      <h2 className="page-heading">{t('settings:view.heading')}</h2>
      <div className="card">
        <div className="setting-row stat-picks">
          <span>
            <strong>{t('settings:view.amount')}</strong>
            <small>{t(`settings:view.${current}.detail`)}</small>
          </span>
          <div className="stat-chips" role="radiogroup" aria-label={t('settings:view.heading')}>
            {viewModes.map((mode) => (
              <button
                type="button"
                key={mode}
                role="radio"
                className="stat-chip"
                aria-checked={mode === view.mode}
                onClick={() => set({ mode })}
              >
                {t(`settings:view.${mode}.label`)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

// The strip under the input box: its two parts each show the figures switched on, and open a card with all of them.
function SessionBarSettings() {
  const t = useT();
  const { sessionBar } = usePrefs();
  const set = (values: Partial<typeof sessionBar>) =>
    setPrefs((prefs) => ({ ...prefs, sessionBar: { ...prefs.sessionBar, ...values } }));
  const preview = (['session', 'tokens'] as const)
    .map((group) => barText(t, group, sampleSession, sessionBar.summary))
    .filter(Boolean)
    .join('　　');
  return (
    <>
      <h2 className="page-heading">{t('settings:bar.heading')}</h2>
      <div className="card">
        <Row title={t('settings:bar.show')} detail={t('settings:bar.detail')}>
          <Switch
            label={t('settings:bar.show')}
            checked={sessionBar.enabled}
            onChange={(enabled) => set({ enabled })}
          />
        </Row>
        <div className="setting-row stat-picks">
          <span>
            <strong>{t('settings:bar.parts')}</strong>
            <small>{preview || t('settings:bar.partsDetail')}</small>
          </span>
          <div className="stat-chips" role="group" aria-label={t('settings:bar.parts')}>
            {sessionFields(t).map((field) => {
              const on = inBar(field, sessionBar.summary);
              return (
                <button
                  type="button"
                  key={field.key}
                  className="stat-chip"
                  aria-pressed={on}
                  disabled={!sessionBar.enabled}
                  onClick={() => set({ summary: { ...sessionBar.summary, [field.key]: !on } })}
                >
                  {field.label}
                </button>
              );
            })}
          </div>
        </div>
        <Row title={t('settings:reset')} detail={t('settings:bar.resetDetail')}>
          <button
            type="button"
            className="button"
            disabled={Object.keys(sessionBar.summary).length === 0}
            onClick={() => set({ summary: {} })}
          >
            {t('settings:reset')}
          </button>
        </Row>
      </div>
    </>
  );
}

// The line under each reply is a choice of this computer's window, so it works outside the desktop app too.
function ReplyStats() {
  const t = useT();
  const { stats } = usePrefs();
  const set = (values: Partial<typeof stats>) =>
    setPrefs((prefs) => ({ ...prefs, stats: { ...prefs.stats, ...values } }));
  return (
    <>
      <h2 className="page-heading">{t('settings:summary.heading')}</h2>
      <div className="card">
        <Row
          title={t('settings:summary.show')}
          detail={t('settings:summary.detail')}
          help="context#numbers"
        >
          <Switch
            label={t('settings:summary.show')}
            checked={stats.enabled}
            onChange={(enabled) => set({ enabled })}
          />
        </Row>
        <div className="setting-row stat-picks">
          <span>
            <strong>{t('settings:summary.parts')}</strong>
            <small>
              {summaryText(t, sampleStats, stats.summary) || t('settings:summary.partsDetail')}
            </small>
          </span>
          <div className="stat-chips" role="group" aria-label={t('settings:summary.parts')}>
            {statFields(t).map((field) => {
              const on = inSummary(field, stats.summary);
              return (
                <button
                  type="button"
                  key={field.key}
                  className="stat-chip"
                  aria-pressed={on}
                  disabled={!stats.enabled}
                  onClick={() => set({ summary: { ...stats.summary, [field.key]: !on } })}
                >
                  {field.label}
                </button>
              );
            })}
          </div>
        </div>
        <Row title={t('settings:reset')} detail={t('settings:summary.resetDetail')}>
          <button
            type="button"
            className="button"
            disabled={Object.keys(stats.summary).length === 0}
            onClick={() => set({ summary: {} })}
          >
            {t('settings:reset')}
          </button>
        </Row>
      </div>
    </>
  );
}

// A number of seconds, taken when the field is left or Enter is pressed; anything out of range is put back.
function Seconds({
  label,
  value,
  change,
}: {
  label: string;
  value: number;
  change: (value: number) => void;
}) {
  const t = useT();
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const seconds = Number(text);
    if (Number.isInteger(seconds) && seconds >= waitRange.min && seconds <= waitRange.max)
      change(seconds);
    else setText(String(value));
  };
  return (
    <span className="setting-actions">
      <input
        className="setting-number"
        type="number"
        min={waitRange.min}
        max={waitRange.max}
        aria-label={label}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
        }}
      />
      {t('settings:seconds')}
    </span>
  );
}

// The computer's connections, each a window of its own to a service of its own: see electron/connections.cjs.
function Connections() {
  const t = useT();
  const [list, setList] = useState<Account[]>([]);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState('');
  const names = useShared('connections');
  // Whether a window is open is its process's to tell, so it is asked again while the page is shown.
  useEffect(() => {
    const read = () => void window.desktop!.accounts().then(setList);
    read();
    const timer = setInterval(read, 2000);
    return () => clearInterval(timer);
  }, [names]);
  const act = (work: Promise<Account[] | void>) =>
    work.then(
      (next) => {
        setError('');
        if (next) setList(next);
        return true;
      },
      (failure) => {
        setError(String(failure?.message ?? failure));
        return false;
      },
    );
  return (
    <>
      <h2 className="page-heading">{t('settings:connections.heading')}</h2>
      <div className="card">
        {list
          .map((item) => ({ ...item, label: item.label || t('settings:connections.unsaved') }))
          .map((entry) => (
            <Row key={entry.id} title={entry.label} detail={entry.name ? entry.url : undefined}>
              {editing?.id === entry.id ? (
                <form
                  className="setting-actions"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(window.desktop!.renameAccount(entry.id, editing.name)).then(
                      (done) => done && setEditing(null),
                    );
                  }}
                >
                  <input
                    className="setting-name"
                    aria-label={t('settings:connections.nickname')}
                    placeholder={t('settings:connections.nicknameHint')}
                    maxLength={24}
                    autoFocus
                    value={editing.name}
                    onChange={(event) => setEditing({ id: entry.id, name: event.target.value })}
                  />
                  <button type="submit" className="button">
                    {t('common:save')}
                  </button>
                  <button type="button" className="button" onClick={() => setEditing(null)}>
                    {t('common:cancel')}
                  </button>
                </form>
              ) : (
                <span className="setting-actions">
                  {!entry.current && (
                    <button
                      type="button"
                      className="button"
                      aria-label={t('settings:connections.openOf', { label: entry.label })}
                      onClick={() => void act(window.desktop!.openAccount(entry.id))}
                    >
                      {entry.open
                        ? t('settings:connections.switch')
                        : t('settings:connections.open')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="button"
                    aria-label={t('settings:connections.nicknameOf', { label: entry.label })}
                    onClick={() => setEditing({ id: entry.id, name: entry.name })}
                  >
                    {t('settings:connections.nickname')}
                  </button>
                  {!entry.current && (
                    <button
                      type="button"
                      className="button danger"
                      aria-label={t('settings:connections.deleteOf', { label: entry.label })}
                      onClick={() => {
                        if (
                          window.confirm(
                            t('settings:connections.deleteQuestion', { label: entry.label }),
                          )
                        )
                          void act(window.desktop!.forgetAccount(entry.id));
                      }}
                    >
                      {t('settings:connections.delete')}
                    </button>
                  )}
                </span>
              )}
            </Row>
          ))}
        <Row title={t('settings:connections.newWindow')}>
          <button
            type="button"
            className="button"
            onClick={() => void act(window.desktop!.newLoginWindow())}
          >
            {t('settings:connections.open')}
          </button>
        </Row>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

// The history read before and kept here; clearing it has every session read from the service again. Each
// connection keeps its own: a sign-in window, no connection's, has none to show.
function HistoryCacheCard({ client }: { client: ProxyClient }) {
  const t = useT();
  const [stats, setStats] = useState<Awaited<ReturnType<ProxyClient['disk']['stats']>>>(null);
  const read = () => void client.disk.stats().then(setStats);
  useEffect(read, [client]);
  if (!stats || window.desktop?.boot?.launcher) return null;
  const size = !stats.bytes
    ? ''
    : stats.bytes < 1024 * 1024
      ? t('settings:cache.kb', { n: Math.ceil(stats.bytes / 1024) })
      : stats.bytes < 1024 * 1024 * 1024
        ? t('settings:cache.mb', { n: (stats.bytes / 1024 / 1024).toFixed(1) })
        : t('settings:cache.gb', { n: (stats.bytes / 1024 / 1024 / 1024).toFixed(2) });
  return (
    <>
      <h2 className="page-heading">{t('settings:cache.heading')}</h2>
      <div className="card">
        <Row title={t('settings:cache.title')} detail={t('settings:cache.detail')}>
          <span className="setting-actions">
            <span className="setting-value">
              {size && `${size} · `}
              {t('settings:cache.sessions', { count: stats.sessions })}
            </span>
            <button
              type="button"
              className="button"
              onClick={() => {
                client.resync();
                read();
              }}
            >
              {t('settings:cache.clean')}
            </button>
          </span>
        </Row>
      </div>
    </>
  );
}

function General({
  client,
  browser,
  workspaceRoot,
  chooseWorkspace,
}: {
  client: ProxyClient;
  browser: boolean;
  workspaceRoot: string;
  chooseWorkspace: (reset: boolean) => void;
}) {
  const t = useT();
  const [closeToTray, setCloseToTray] = useState<boolean | null>(null);
  const { bypassPermissions } = usePrefs();
  useEffect(() => {
    void window.desktop?.windowSettings().then((values) => setCloseToTray(values.closeToTray));
  }, []);
  return (
    <Page title={sectionName(t, 'general')} intro={localScope(t, browser)}>
      {window.desktop && (
        <>
          <h2 className="page-heading">{t('settings:window.heading')}</h2>
          <div className="card">
            <Row
              title={t('settings:window.background')}
              detail={t('settings:window.backgroundDetail')}
              help="background"
            >
              <Switch
                label={t('settings:window.background')}
                checked={closeToTray ?? true}
                disabled={closeToTray === null}
                onChange={(value) => {
                  setCloseToTray(value);
                  void window.desktop!.setWindowSettings({ closeToTray: value });
                }}
              />
            </Row>
          </div>
          <h2 className="page-heading">{t('settings:sessions.heading')}</h2>
          <div className="card">
            <Row
              title={t('settings:sessions.folder')}
              detail={
                <>
                  {t('settings:sessions.folderDetail')}
                  <code className="setting-path">{workspaceRoot}</code>
                </>
              }
            >
              <span className="setting-actions">
                <button type="button" className="button" onClick={() => chooseWorkspace(false)}>
                  {t('settings:sessions.change')}
                </button>
                <button type="button" className="button" onClick={() => chooseWorkspace(true)}>
                  {t('settings:reset')}
                </button>
              </span>
            </Row>
          </div>
        </>
      )}
      <HistoryCacheCard client={client} />
      <h2 className="page-heading">{t('settings:approval.heading')}</h2>
      <div className="card">
        <Row
          title={t('settings:approval.bypass')}
          detail={t('settings:approval.bypassDetail')}
          help="permissions#bypass"
        >
          <Switch
            label={t('settings:approval.bypass')}
            checked={bypassPermissions}
            onChange={(value) => setPrefs((prefs) => ({ ...prefs, bypassPermissions: value }))}
          />
        </Row>
      </div>
    </Page>
  );
}

function Appearance({ browser }: { browser: boolean }) {
  const t = useT();
  const { quota } = usePrefs();
  return (
    <Page title={sectionName(t, 'appearance')} intro={localScope(t, browser)}>
      <LanguageSettings />
      <ThemeSettings />
      {window.desktop && (
        <>
          <h2 className="page-heading">{t('settings:input.heading')}</h2>
          <div className="card">
            <Row title={t('settings:input.quota')} detail={t('settings:input.quotaDetail')}>
              <Switch
                label={t('settings:input.quota')}
                checked={quota}
                onChange={(value) => setPrefs((prefs) => ({ ...prefs, quota: value }))}
              />
            </Row>
          </div>
        </>
      )}
      <TranscriptViewSettings />
      <ReplyStats />
      <SessionBarSettings />
    </Page>
  );
}

function ConnectionSettings({
  form,
  changeForm,
}: {
  form: ConnectionForm;
  changeForm: (values: Partial<ConnectionForm>) => void;
}) {
  const t = useT();
  const { connection } = usePrefs();
  return (
    <Page title={sectionName(t, 'connection')} intro={localScope(t, false)}>
      <h2 className="page-heading">{t('settings:signIn.heading')}</h2>
      <div className="card">
        <Row title={t('settings:signIn.remember')} detail={t('settings:signIn.rememberDetail')}>
          <Switch
            label={t('settings:signIn.remember')}
            checked={form.remember}
            onChange={(remember) => changeForm({ remember, autoLogin: remember && form.autoLogin })}
          />
        </Row>
        <Row title={t('settings:signIn.auto')} detail={t('settings:signIn.autoDetail')}>
          <Switch
            label={t('settings:signIn.auto')}
            checked={form.autoLogin}
            onChange={(autoLogin) =>
              changeForm({ autoLogin, remember: autoLogin || form.remember })
            }
          />
        </Row>
      </div>
      <Connections />
      <SettingsHeading help="execution#waits">{t('settings:wait.heading')}</SettingsHeading>
      <div className="card">
        {waitFields(t).map(({ step, title, detail }) => (
          <Row
            key={step}
            title={title}
            detail={t('settings:wait.withDefault', { detail, seconds: connectionWaits[step] })}
          >
            <Seconds
              label={title}
              value={connection[step]}
              change={(seconds) =>
                setPrefs((prefs) => ({
                  ...prefs,
                  connection: { ...prefs.connection, [step]: seconds },
                }))
              }
            />
          </Row>
        ))}
        <Row title={t('settings:reset')} detail={t('settings:wait.resetDetail')}>
          <button
            type="button"
            className="button"
            disabled={waitFields(t).every(({ step }) => connection[step] === connectionWaits[step])}
            onClick={() => setPrefs((prefs) => ({ ...prefs, connection: connectionWaits }))}
          >
            {t('settings:reset')}
          </button>
        </Row>
      </div>
    </Page>
  );
}
function Notices() {
  const t = useT();
  const { notify } = usePrefs();
  const set = (values: Partial<typeof notify>) =>
    setPrefs((prefs) => ({ ...prefs, notify: { ...prefs.notify, ...values } }));
  return (
    <Page title={t('settings:notify.heading')} intro={t('settings:notify.intro')}>
      <div className="card">
        <Row title={t('settings:notify.enabled')} detail={t('settings:notify.enabledDetail')}>
          <Switch
            label={t('settings:notify.enabled')}
            checked={notify.enabled}
            onChange={(enabled) => set({ enabled })}
          />
        </Row>
        <Row title={t('settings:notify.sound')} detail={t('settings:notify.soundDetail')}>
          <Switch
            label={t('settings:notify.sound')}
            checked={notify.sound}
            disabled={!notify.enabled}
            onChange={(sound) => set({ sound })}
          />
        </Row>
      </div>
      <h2 className="page-heading">{t('settings:notify.which')}</h2>
      <div className="card">
        {kinds.map((key) => (
          <Row
            key={key}
            title={t(`settings:notify.${key}.title`)}
            detail={t(`settings:notify.${key}.detail`)}
          >
            <Switch
              label={t(`settings:notify.${key}.title`)}
              checked={notify[key]}
              disabled={!notify.enabled}
              onChange={(value) => set({ [key]: value })}
            />
          </Row>
        ))}
      </div>
      {window.desktop && (
        <button
          type="button"
          className="button"
          onClick={() =>
            void window.desktop!.notify({
              title: t('settings:notify.testTitle'),
              body: t('settings:notify.testBody'),
              sessionId: null,
              silent: !notify.sound,
              always: true,
            })
          }
        >
          {t('settings:notify.test')}
        </button>
      )}
    </Page>
  );
}

function About({
  version,
  service,
  adapterName,
  updates,
  showNotes,
}: {
  version: string;
  service: string | null;
  adapterName: string;
  updates: MenuItem[];
  showNotes: (version: string) => void;
}) {
  const t = useT();
  return (
    <Page title={t('settings:section.about.name')}>
      <div className="card">
        <Row title={t('settings:about.client')}>
          <span className="setting-actions">
            <span className="setting-value">{version || t('settings:about.devEntry')}</span>
            {version && (
              <button type="button" className="button" onClick={() => showNotes(version)}>
                {t('settings:about.notes')}
              </button>
            )}
          </span>
        </Row>
        <Row title={t('settings:about.service')}>
          <span className="setting-value">{service ?? t('settings:about.unknown')}</span>
        </Row>
        <Row title={t('settings:about.adapter')}>
          <span className="setting-value">{adapterName}</span>
        </Row>
      </div>
      <h2 className="page-heading">{t('settings:about.updates')}</h2>
      <div className="card">
        <Row
          title={t('settings:about.sameVersion')}
          detail={
            selfUpdating
              ? t('settings:about.updatesFromService')
              : t('settings:about.updatesManual')
          }
        >
          <span className="setting-actions">
            {updates.map((item) => (
              <button
                type="button"
                className="button"
                key={item.label}
                disabled={item.disabled}
                onClick={item.run}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
            {!selfUpdating && project.url ? (
              <button
                type="button"
                className="button"
                onClick={() =>
                  void window.desktop!.openExternal(
                    service
                      ? `${project.url}/releases/tag/v${service}`
                      : `${project.url}/releases/latest`,
                  )
                }
              >
                {t('settings:about.releases')}
              </button>
            ) : (
              updates.length === 0 && (
                <span className="setting-value">{t('settings:about.noUpdates')}</span>
              )
            )}
          </span>
        </Row>
      </div>
      {window.desktop && (
        <>
          <h2 className="page-heading">{t('settings:about.troubleshoot')}</h2>
          <div className="card">
            <Row title={t('settings:about.log')} detail={t('settings:about.logDetail')}>
              <button
                type="button"
                className="button"
                onClick={() => void window.desktop!.openLogs()}
              >
                {t('settings:about.openLog')}
              </button>
            </Row>
            <Row title={t('settings:about.devTools')} detail={t('settings:about.devToolsDetail')}>
              <button
                type="button"
                className="button"
                onClick={() => void window.desktop!.openDevTools()}
              >
                {t('settings:about.openDevTools')}
              </button>
            </Row>
          </div>
        </>
      )}
      {project.url && (
        <button type="button" className="button" onClick={openProject}>
          <GithubMark />
          {t('settings:about.homepage', { name: project.name })}
        </button>
      )}
    </Page>
  );
}

// Settings in one place, sorted by where they are kept: this computer, the service, or Claude Code's own files on the
// cloud host.
export default function SettingsPage({
  client,
  section,
  indexOnly = false,
  go,
  native,
  account,
  form,
  changeForm,
  workspaceRoot,
  chooseWorkspace,
  version,
  service,
  adapterName,
  updates,
  showNotes,
  back,
  disconnect,
  browser = false,
  here,
  syncInstructions,
  plugins = [],
}: {
  // The selected session's project, whose instructions and skills can be synced with the service.
  syncInstructions?: { name: string; open: () => void };
  // The service's plugins, once there is a connection to one.
  plugins?: Plugin[];
  // This computer as the service lists it, with the shells it runs Claude's scripts in. A Windows one has a page for
  // the shell Claude should prefer.
  here?: ConnectedDevice;
  // Given before a connection exists: only this computer's own settings are shown, and this leaves them.
  back?: () => void;
  disconnect?: () => void;
  browser?: boolean;
  client: ProxyClient;
  section: Section;
  indexOnly?: boolean;
  go: (section: Section) => void;
  native: boolean;
  // The account page is rendered by the caller, which owns its data.
  account: ReactNode;
  form: ConnectionForm;
  changeForm: (values: Partial<ConnectionForm>) => void;
  workspaceRoot: string;
  chooseWorkspace: (reset: boolean) => void;
  version: string;
  service: string | null;
  adapterName: string;
  updates: MenuItem[];
  showNotes: (version: string) => void;
}) {
  const t = useT();
  const [search, setSearch] = useState('');
  const term = search.trim().toLowerCase();
  // Before a connection only this computer's; in a browser no computer's own nor Claude Code's files; the service's
  // where there is one to keep them. A page with nothing to set where it is shown is not listed.
  // In a browser the account page shows only the plan's usage, under that name.
  const shown = sections
    .map((item) => {
      const usage = browser && item.id === 'account';
      return {
        ...item,
        name: usage ? t('settings:section.usage.name') : sectionName(t, item.id),
        words: usage ? t('settings:section.usage.words') : sectionWords(t, item.id),
      };
    })
    .filter(
      (item) =>
        (!back || item.group === 'local') &&
        (item.id !== 'connection' || window.desktop) &&
        (item.id !== 'install' ||
          (browser && /Android.*Mobile|iPhone|iPod/i.test(navigator.userAgent))) &&
        (!browser || !['context', 'claude', 'instructions'].includes(item.id)) &&
        (item.id !== 'account' || native || !browser) &&
        (item.id !== 'context' || native) &&
        (item.id !== 'shell' || (native && !browser && !!here && platformOf(here) === 'win32')) &&
        (item.id !== 'web' || native || browser) &&
        `${item.name} ${item.words}`.toLowerCase().includes(term),
    );
  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-brand">
          {back && (
            <IconButton title={t('settings:backToSignIn')} onClick={back}>
              <ArrowLeft />
            </IconButton>
          )}
          <span className="brand">{back ? t('settings:localTitle') : t('nav:bar.settings')}</span>
          {!back && <HelpLink article="settings" title={t('settings:help')} />}
        </div>
        <label className="session-search">
          <Search />
          <input
            aria-label={t('settings:search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('nav:search')}
          />
        </label>
        <nav className="session-list" aria-label={t('settings:categories')}>
          {shown.map((item, index) => (
            <div key={item.id}>
              {item.group !== shown[index - 1]?.group && (
                <div className="list-heading">{t(`settings:group.${item.group}`)}</div>
              )}
              <button
                type="button"
                className="side-action"
                aria-current={!indexOnly && item.id === section ? 'page' : undefined}
                onClick={() => go(item.id)}
              >
                <item.icon />
                {item.name}
              </button>
            </div>
          ))}
          {shown.length === 0 && <p className="list-empty">{t('settings:noMatch')}</p>}
        </nav>
        {disconnect && (
          <button
            type="button"
            className="side-action settings-logout mobile-only"
            onClick={disconnect}
          >
            <LogOut />
            {browser ? t('nav:bar.signOut') : t('nav:bar.disconnect')}
          </button>
        )}
      </aside>
      <main className="workspace">
        <PageHelp.Provider value={back ? null : (pageHelp[section] ?? 'settings')}>
          {indexOnly ? null : section === 'account' ? (
            account
          ) : section === 'claude' ? (
            native ? (
              <SettingsPanel client={client} />
            ) : (
              <Page title={sectionName(t, 'claude')} intro={t('settings:simulation.cli')} />
            )
          ) : section === 'instructions' ? (
            native ? (
              <GlobalInstructions client={client} sync={syncInstructions} />
            ) : (
              <Page
                title={sectionName(t, 'instructions')}
                intro={t('settings:simulation.instructions')}
              />
            )
          ) : section === 'context' ? (
            <Page title={sectionName(t, 'context')} intro={t('settings:scope.everyDevice')}>
              <IdleCompactionSettings client={client} />
            </Page>
          ) : section === 'shell' && here ? (
            <Page title={sectionName(t, 'shell')} intro={t('settings:scope.thisDevice')}>
              <ShellSettings client={client} here={here} />
            </Page>
          ) : section === 'web' ? (
            <Page title={sectionName(t, 'web')} intro={t('settings:scope.everyDevice')}>
              <WebAccessSettings client={client} browser={browser} connectionUrl={form.url} />
            </Page>
          ) : section === 'plugins' ? (
            <PluginSettings client={client} plugins={plugins} />
          ) : section === 'install' && browser ? (
            <InstallAppSettings />
          ) : section === 'general' ? (
            <General
              client={client}
              browser={browser}
              workspaceRoot={workspaceRoot}
              chooseWorkspace={chooseWorkspace}
            />
          ) : section === 'appearance' ? (
            <Appearance browser={browser} />
          ) : section === 'connection' ? (
            <ConnectionSettings form={form} changeForm={changeForm} />
          ) : section === 'notifications' ? (
            <Notices />
          ) : section === 'shortcuts' ? (
            <ShortcutSettings />
          ) : (
            <About
              version={version}
              service={service}
              adapterName={adapterName}
              updates={updates}
              showNotes={showNotes}
            />
          )}
        </PageHelp.Provider>
      </main>
    </>
  );
}
