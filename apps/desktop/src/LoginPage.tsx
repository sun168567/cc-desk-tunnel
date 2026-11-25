import { ChevronDown, Download, Settings, SquareTerminal, Unplug, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { FORCED_UPGRADE_SINCE } from '@cc-desk-tunnel/protocol';
import type { ClientUpgrade } from './client-upgrade.ts';
import UpgradeProgress from './UpgradeProgress.tsx';
import { thisDevice } from './device.ts';
import { say, useT } from './i18n.ts';
import { GithubMark, openProject, project } from './project.tsx';
import { serviceKey } from './shared.ts';
import type { Account } from './shared.ts';

// What the token field shows for a token its connection keeps, which this window never reads.
const keptToken = '\u2022'.repeat(10);

export type ConnectionForm = {
  url: string;
  token: string;
  fingerprint: string;
  mode: 'local' | 'remote';
  // Desktop only: keep the token (encrypted for this Windows account), and sign in when the program is started
  // with no window open, which only one service does.
  remember: boolean;
  autoLogin: boolean;
  // An earlier version's connection that kept no address, to take the one given now.
  id?: string;
};

// The sign-in window's form (see Launcher.tsx).
export default function LoginPage({
  form,
  change,
  connecting,
  cancel,
  error,
  upgrade,
  direct,
  upgrading,
  older,
  serviceUpgraded,
  newer,
  showNotes,
  submit,
  openSettings,
}: {
  form: ConnectionForm;
  change: (values: Partial<ConnectionForm>) => void;
  connecting: boolean;
  // Gives up the sign-in under way.
  cancel?: () => void;
  error: string | null;
  // The version of the installer a service of another version offers this client.
  upgrade: string | null;
  // The service's version, when this client is the older one: its installer can be fetched from the release
  // page instead.
  direct: string | null;
  // Fetches and runs the installer the service holds, or the given version's from the release page, and tells
  // how that goes.
  upgrading: ClientUpgrade;
  // The service's version, when it refused this client as the newer one: it can be asked to upgrade itself.
  older: string | null;
  // The service upgraded itself from `older` and is restarting.
  serviceUpgraded: (from: string) => void;
  // The version the service is at or offers, when it is newer than this client: its notes can be read.
  newer: string | null;
  // Shows what a version changed.
  showNotes: (version: string) => void;
  submit: () => void;
  // This computer's own settings, which need no connection.
  openSettings?: () => void;
}) {
  const t = useT();
  // The services this computer has signed in to, each a window of its own (see electron/connections.cjs): one
  // fills the form, and its record can be forgotten. A remembered token is not read here: the sign-in takes it.
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const picker = useRef<HTMLDivElement>(null);
  const readAccounts = () => {
    void window.desktop?.accounts().then(setAccounts);
  };
  useEffect(readAccounts, []);
  useEffect(() => {
    if (!listOpen) return;
    const away = (event: PointerEvent) => {
      if (!picker.current?.contains(event.target as Node)) setListOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [listOpen]);
  const failed = (failure: unknown) =>
    setListError(
      String((failure as Error)?.message ?? failure).replace(/^.*?'accounts:\w+': (Error: )?/, ''),
    );
  // A service whose token its connection keeps shows the field filled. Typing there replaces it; emptied, the
  // field asks for one again.
  const [replaced, setReplaced] = useState<string | null>(null);
  const remembered =
    !form.token &&
    replaced !== serviceKey(form.url) &&
    !!accounts.find((account) => account.url && serviceKey(account.url) === serviceKey(form.url))
      ?.saved;
  function choose(account: Account) {
    setListOpen(false);
    setListError(null);
    setReplaced(null);
    change({
      // An earlier version's connection that kept no address takes the one typed in.
      ...(account.url ? { id: undefined } : { id: account.id }),
      url: account.url,
      fingerprint: account.fingerprint,
      mode: account.mode,
      token: '',
      remember: account.saved,
      autoLogin: account.autoLogin,
    });
  }
  function forget(account: Account) {
    if (
      !window.confirm(
        t('connection:login.forgetConfirm', {
          name: account.label || t('connection:login.unnamed'),
        }),
      )
    )
      return;
    window.desktop!.forgetAccount(account.id).then((next) => {
      setListError(null);
      setAccounts(next);
      if (!next.length) setListOpen(false);
    }, failed);
  }
  const [serviceUpgrade, setServiceUpgrade] = useState<{
    phase: 'running' | 'done' | 'failed';
    text: string;
    // Refused for sessions at work, by a service that can be forced past them.
    forcible?: boolean;
  } | null>(null);
  // A new attempt to connect, by hand or once an upgraded service is back, has its own outcome to tell.
  useEffect(() => {
    if (connecting) setServiceUpgrade(null);
  }, [connecting]);
  function upgradeService(service: string, force = false) {
    if (
      !window.confirm(
        force
          ? t('connection:upgrade.serviceForceConfirm', { service })
          : t('connection:upgrade.serviceConfirm', { service }),
      )
    )
      return;
    setServiceUpgrade({ phase: 'running', text: t('connection:upgrade.serviceRunning') });
    const stop = window.desktop!.onServiceUpgrade(
      (update) =>
        update.detail &&
        setServiceUpgrade({
          phase: 'running',
          text: t('connection:upgrade.serviceStep', { step: say(update.detail) }),
        }),
    );
    void thisDevice()
      .then((device) =>
        window.desktop!.upgradeService({
          url: form.url,
          fingerprint: form.fingerprint,
          token: form.token.trim(),
          deviceName: device.name,
          service,
          ...(force ? { force } : {}),
        }),
      )
      .then(({ version, error, phrase, code }) => {
        if (version) serviceUpgraded(service);
        setServiceUpgrade(
          version
            ? { phase: 'done', text: t('connection:upgrade.serviceDone', { version }) }
            : {
                phase: 'failed',
                text: phrase
                  ? say(phrase, error)
                  : (error ?? t('connection:upgrade.serviceFailed')),
                forcible:
                  code === 'busy' &&
                  service.localeCompare(FORCED_UPGRADE_SINCE, undefined, { numeric: true }) >= 0,
              },
        );
      })
      .finally(stop);
  }
  const shownError =
    listError ??
    (serviceUpgrade && serviceUpgrade.phase !== 'running' ? serviceUpgrade.text : error);
  return (
    <main className="login-page">
      <div className="window-drag" />
      <div className="login-content">
        <div className="brand">
          <SquareTerminal />
          <span>CC Desk Tunnel</span>
        </div>
        <div className="login-title">
          <h1>{t('connection:login.title')}</h1>
          {form.mode === 'local' && (
            <span className="badge simulation">{t('connection:login.simulation')}</span>
          )}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setServiceUpgrade(null);
            submit();
          }}
          className="connection-form"
        >
          {window.desktop?.dev && (
            <div className="connection-modes" role="group" aria-label={t('connection:login.mode')}>
              <button
                type="button"
                aria-pressed={form.mode === 'local'}
                onClick={() => change({ mode: 'local' })}
              >
                {t('connection:login.local')}
              </button>
              <button
                type="button"
                aria-pressed={form.mode === 'remote'}
                onClick={() => change({ mode: 'remote' })}
              >
                {t('connection:login.remote')}
              </button>
            </div>
          )}
          <div
            className="login-account"
            ref={picker}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && listOpen) {
                event.stopPropagation();
                setListOpen(false);
              }
            }}
          >
            <label>
              {t('connection:login.url')}
              <input
                autoFocus
                type="url"
                value={form.url}
                onChange={(event) => change({ url: event.target.value })}
                required
                spellCheck={false}
              />
            </label>
            {accounts.length > 0 && (
              <button
                type="button"
                className="icon-button login-account-toggle"
                aria-label={t('connection:login.accounts')}
                aria-expanded={listOpen}
                onClick={() => {
                  if (!listOpen) readAccounts();
                  setListOpen(!listOpen);
                }}
              >
                <ChevronDown />
              </button>
            )}
            {listOpen && accounts.length > 0 && (
              <ul className="login-accounts" aria-label={t('connection:login.accounts')}>
                {accounts.map((account) => (
                  <li key={account.id}>
                    <button
                      type="button"
                      className="login-account-choice"
                      onClick={() => choose(account)}
                    >
                      <span className="login-account-name">
                        {account.label || t('connection:login.unnamed')}
                      </span>
                      {account.name && account.url && (
                        <span className="login-account-detail">{account.url}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={t('connection:login.forgetLabel', {
                        name: account.label || t('connection:login.unnamed'),
                      })}
                      title={t('connection:login.forget')}
                      onClick={() => forget(account)}
                    >
                      <X />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {form.mode === 'remote' && (
            <label>
              {t('connection:login.fingerprintOptional')}
              <input
                aria-label={t('connection:login.fingerprint')}
                value={form.fingerprint}
                onChange={(event) => change({ fingerprint: event.target.value })}
                placeholder={t('connection:login.fingerprintPlaceholder')}
                spellCheck={false}
              />
            </label>
          )}
          <label>
            {t('connection:login.token')}
            <input
              type="password"
              value={remembered ? keptToken : form.token}
              onChange={(event) => {
                if (!remembered) return change({ token: event.target.value });
                setReplaced(serviceKey(form.url));
                change({ token: event.target.value.replaceAll('\u2022', '') });
              }}
              required
              autoComplete="off"
            />
          </label>
          {window.desktop && (
            <div className="login-options">
              <label>
                <input
                  type="checkbox"
                  checked={form.remember}
                  onChange={(event) =>
                    change({
                      remember: event.target.checked,
                      autoLogin: event.target.checked && form.autoLogin,
                    })
                  }
                />
                {t('connection:login.remember')}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.autoLogin}
                  onChange={(event) =>
                    change({
                      autoLogin: event.target.checked,
                      remember: event.target.checked || form.remember,
                    })
                  }
                />
                {t('connection:login.autoLogin')}
              </label>
            </div>
          )}
          {shownError && (
            <p className="error-text" role="alert">
              {shownError}
            </p>
          )}
          <UpgradeProgress upgrade={upgrading} />
          {upgrade && !upgrading.step && (
            <button
              className="button login-submit"
              type="button"
              disabled={connecting}
              onClick={() => upgrading.start()}
            >
              <Download />
              {t('connection:upgrade.client', { version: upgrade })}
            </button>
          )}
          {older && serviceUpgrade?.phase !== 'done' && (
            <button
              className="button login-submit"
              type="button"
              disabled={connecting || serviceUpgrade?.phase === 'running'}
              onClick={() => upgradeService(older)}
            >
              <Download />
              {serviceUpgrade?.phase === 'running'
                ? serviceUpgrade.text
                : t('connection:upgrade.service')}
            </button>
          )}
          {older && serviceUpgrade?.forcible && (
            <button
              className="button login-submit"
              type="button"
              disabled={connecting}
              onClick={() => upgradeService(older, true)}
            >
              <Download />
              {t('connection:upgrade.serviceForce')}
            </button>
          )}
          {newer && (
            <button className="button login-submit" type="button" onClick={() => showNotes(newer)}>
              {t('connection:upgrade.notes', { version: newer })}
            </button>
          )}
          {direct && !upgrading.step && (
            <button
              className="button login-submit"
              type="button"
              disabled={connecting}
              onClick={() => upgrading.start(direct)}
            >
              <Download />
              {upgrade
                ? t('connection:upgrade.fromGithubInstead', { version: direct })
                : t('connection:upgrade.fromGithub', { version: direct })}
            </button>
          )}
          <button className="button primary login-submit" disabled={connecting || !!upgrading.step}>
            <Unplug />
            {connecting ? t('connection:login.connecting') : t('connection:login.connect')}
          </button>
          {connecting && cancel && (
            <button className="button login-submit" type="button" onClick={cancel}>
              {t('common:cancel')}
            </button>
          )}
        </form>
        <div className="login-links">
          {openSettings && (
            <button className="project-link" type="button" onClick={openSettings}>
              <Settings />
              {t('connection:login.localSettings')}
            </button>
          )}
          {project.url && (
            <button className="project-link" type="button" onClick={openProject}>
              <GithubMark />
              {project.name}
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
