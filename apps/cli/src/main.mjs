import { appendFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { FORCED_UPGRADE_SINCE, projectOf } from '@cc-desk-tunnel/protocol';
import { upgradeService } from '../../desktop/electron/service-upgrade.mjs';
import { Config, hostOf, sameService, serviceKey } from './config.mjs';
import { Service, proxyFor } from './connection.mjs';
import { readKeys } from './keys.mjs';
import { pad, pick } from './picker.mjs';
import { choices, entries, parse, readRemote, save, shown } from './settings.mjs';
import { discard, protect, reveal } from './secret.mjs';
import { bundled, desktop, releasePage, version } from './runtime.mjs';
import { relay } from './terminal.mjs';
import { markOnline, onlineAt, stayOnline } from './online.mjs';
import { FIRST_UPGRADABLE, download, install } from './upgrade.mjs';
import { EXIT } from './agent.mjs';
import { serveAcp } from './acp.mjs';
import { failureText, t, useLanguage, wordsOf } from './i18n.mjs';
import {
  answer,
  approve,
  deny,
  logs,
  printTask,
  status as statusOf,
  stop,
  tell,
  wait,
} from './tasks.mjs';
import { UPDATE_TICK_MS, lookDue } from '../../desktop/src/update-check.ts';
import { quotaName } from '../../desktop/src/quota.ts';

const help = () => t('cli:help.main');

// The help written for programs and other agents (`ccdt help agents`).
export const agentHelp = () => t('cli:help.agents');

const say = (text) => process.stderr.write(`${text}\n`);
// `CCDT_LOG` names a file for what the connection did, for finding out why it failed.
const log = (line) => {
  if (process.env.CCDT_LOG)
    appendFileSync(process.env.CCDT_LOG, `${new Date().toISOString()} ${line}\n`);
};
const dim = (text) => (process.stderr.isTTY ? `\x1b[2m${text}\x1b[0m` : text);
const notice = (text) => (process.stderr.isTTY ? `\x1b[33m${text}\x1b[0m` : text);
// What the service last found of a newer release, said before the terminal is shown and after it ends: the screen
// in between is Claude Code's own.
const newer = (update) =>
  update?.state === 'available'
    ? t('cli:update.available', { version: update.latest })
    : update?.state === 'manual'
      ? t('cli:update.manual', { version: update.latest })
      : undefined;

// The session's project directory as the desktop client records it, compared without the case on Windows.
const sameDirectory = (a, b) => {
  const normal = (path) => resolve(path).replace(/[\\/]+$/, '');
  return process.platform === 'win32'
    ? normal(a).toLowerCase() === normal(b).toLowerCase()
    : normal(a) === normal(b);
};
const newest = (sessions) => sessions.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
const when = (time) => {
  const date = new Date(time);
  const today = new Date().toDateString() === date.toDateString();
  const pad = (value) => String(value).padStart(2, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (today) return t('cli:when.today', { clock });
  const day = new Intl.DateTimeFormat(t('common:locale'), { month: 'short', day: 'numeric' });
  return `${day.format(date)} ${clock}`;
};
// Who is using the session now: a terminal of ccdt, which reports what its CLI is doing, or a run started from the
// desktop client.
const using = (run) =>
  run.surface !== 'terminal'
    ? t('cli:using.window')
    : t(`cli:using.${['working', 'waiting'].includes(run.activity) ? run.activity : 'idle'}`);
const status = (session) => (session.activeRun ? ` [${using(session.activeRun)}]` : '');

async function readSecret(prompt) {
  const input = process.stdin;
  if (!input.isTTY) {
    let text = '';
    for await (const chunk of input) text += chunk;
    return text.trim();
  }
  process.stderr.write(prompt);
  let text = '';
  try {
    return await readKeys(input, (chunk) => {
      for (const key of chunk) {
        if (key === '\r' || key === '\n') return text;
        if (key === '\u0003') throw new Error(t('cli:cancelled'));
        text = key === '\u007f' || key === '\b' ? text.slice(0, -1) : text + key;
      }
    });
  } finally {
    process.stderr.write('\n');
  }
}

// A line typed in, shown as it is typed and starting from `text`; Esc gives up (undefined).
async function readLine(prompt, text = '') {
  const draw = () => process.stderr.write(`\r\x1b[K${prompt}${text}`);
  draw();
  try {
    const line = await readKeys(process.stdin, (chunk) => {
      if (chunk === '\x1b') return null;
      // Arrows and other keys that send a sequence change nothing here.
      if (chunk.startsWith('\x1b')) return undefined;
      for (const key of chunk) {
        if (key === '\r' || key === '\n') return text;
        if (key === '\u0003') return null;
        if (key === '\u007f' || key === '\b') text = [...text].slice(0, -1).join('');
        else if (key >= ' ') text += key;
      }
      draw();
    });
    return line ?? undefined;
  } finally {
    process.stderr.write('\n');
  }
}

// What a service is called here: the desktop client's name for the connection to it, else its host.
const called = (server, names) => names.get(serviceKey(server.url)) ?? hostOf(server.url);
// The services signed in to, the one connected to last first, each line its name, when it was last used and its
// address; the one used when none is named is marked.
function serverLines(config, names) {
  const servers = config.servers.toSorted((a, b) => (b.usedAt ?? '').localeCompare(a.usedAt ?? ''));
  return {
    servers,
    lines: servers.map(
      (server) =>
        `${pad(called(server, names), 18)}${pad(server.usedAt ? when(server.usedAt) : '', 14)}${dim(server.url)}${sameService(server.url, config.server()?.url) ? `  ${t('cli:server.current')}` : ''}`,
    ),
  };
}

// The service a command goes to: the one `--server` names, one chosen with -s, else the one connected to last. It is
// chosen once and kept in `values`, for connecting again after a lost connection to go back to it.
async function target(config, values) {
  if (!config.servers.length) {
    if (values.server || !process.stdin.isTTY) throw new Error(t('cli:server.noneLogin'));
    say(t('cli:server.noneFirst'));
    await login(config, values);
  }
  const names = config.names();
  let server = config.server();
  if (values.server) {
    const found = config.find(values.server, names);
    if (found.length > 1)
      throw new Error(
        t('cli:server.ambiguous', {
          name: values.server,
          found: found.map((other) => called(other, names)),
        }),
      );
    if (!found.length) throw new Error(t('cli:server.unknown', { name: values.server }));
    server = found[0];
  } else if (values.select) {
    if (!process.stdin.isTTY) throw new Error(t('cli:server.pickNotTty'));
    const { servers, lines } = serverLines(config, names);
    const chosen = await pick(t('cli:server.pick'), lines, process.stdin, process.stderr, {
      at: servers.indexOf(server),
      hint: t('cli:server.pickHint'),
      clear: true,
    });
    if (chosen === undefined) throw new Error(t('cli:cancelled'));
    server = servers[chosen];
  }
  values.server = server.url;
  values.select = false;
  return server;
}

function credentials(server) {
  const token = process.env.CCDT_TOKEN || reveal(server.url, server.token);
  if (!token) throw new Error(t('cli:server.noToken'));
  return token;
}

// Where `ccdt online` of this computer says it is online, and for which service.
const onlinePath = (config) => join(config.paths.cli, 'online.json');
// A service connected to becomes the one used when none is named. The connection opens an execution channel for
// Claude's commands as `tunnel` says; by default it does unless `ccdt online` carries this computer's already.
async function signIn(config, values, quiet = false, tunnel = undefined) {
  const server = await target(config, values);
  const token = credentials(server);
  if (!quiet) say(dim(t('cli:server.connecting', { name: called(server, config.names()) })));
  const service = await Service.connect({
    ...server,
    token,
    deviceId: config.device(),
    waits: config.waits,
    tunnel: tunnel ?? !onlineAt(onlinePath(config), server.url),
    log,
  });
  config.use(server.url);
  return service;
}

// `ccdt server`: the services signed in to; the one chosen is connected to when none is named.
async function chooseServer(config, values) {
  const names = config.names();
  const { servers, lines } = serverLines(config, names);
  if (!process.stdin.isTTY) return (say(lines.join('\n') || t('cli:server.none')), 0);
  const chosen = await pick(
    t('cli:server.list'),
    [...lines, t('cli:server.loginNew')],
    process.stdin,
    process.stderr,
    {
      at: Math.max(0, servers.indexOf(config.server())),
      hint: t('cli:server.listHint'),
    },
  );
  if (chosen === undefined) return 0;
  if (chosen === servers.length) return (await login(config, values), 0);
  config.use(servers[chosen].url, false);
  say(t('cli:server.chosen', { name: called(servers[chosen], names) }));
  return 0;
}

async function logout(config, values) {
  if (!config.servers.length) return (say(t('cli:server.noneAtAll')), 0);
  values.select ||= !values.server && config.servers.length > 1 && process.stdin.isTTY;
  const server = await target(config, values);
  discard(server.url, server.token);
  config.forget(server.url);
  say(t('cli:server.loggedOut', { name: called(server, config.names()) }));
  return 0;
}

// Without an address the service is one of the desktop client's, or one typed in.
async function login(config, values, url) {
  let server = url ? { url, fingerprint: values.fingerprint ?? '' } : undefined;
  if (!server) {
    const saved = config.desktopLogins();
    let chosen = saved.length === 1 ? 0 : undefined;
    if (process.stdin.isTTY) {
      chosen = await pick(
        t('cli:login.pick'),
        [
          ...saved.map(
            (login) =>
              `${pad(login.name, 18)}${dim(login.url)}${config.servers.some((server) => sameService(server.url, login.url)) ? `  ${t('cli:login.signedIn')}` : ''}`,
          ),
          t('cli:login.other'),
        ],
        process.stdin,
        process.stderr,
        { hint: t('cli:login.pickHint'), clear: true },
      );
      if (chosen === undefined) throw new Error(t('cli:cancelled'));
    }
    if (chosen === undefined) throw new Error(t('cli:login.usage'));
    if (chosen < saved.length) {
      server = {
        url: saved[chosen].url,
        fingerprint: values.fingerprint ?? saved[chosen].fingerprint,
      };
      say(t('cli:login.fromWindow', { name: saved[chosen].name, url: server.url }));
    } else {
      const typed = (await readLine(t('cli:login.address')))?.trim();
      if (!typed) throw new Error(t('cli:cancelled'));
      server = { url: typed, fingerprint: values.fingerprint ?? '' };
    }
  }
  const token = values['token-stdin']
    ? await readSecret('')
    : process.env.CCDT_TOKEN || (await readSecret(t('cli:login.token')));
  // A token the desktop client is connected with right now has been checked: connecting again only to check it
  // would hold up the terminal it is handed over for (see the desktop's ccdt.mjs).
  if (values['no-verify']) say(t('cli:login.done', { url: server.url }));
  else {
    say(dim(t('cli:login.verifying')));
    const service = await Service.connect({
      ...server,
      token,
      deviceId: config.device(),
      waits: config.waits,
      // Checking the token runs no command on this computer.
      tunnel: false,
    });
    say(t('cli:login.doneVersion', { url: server.url, version: service.version }));
    say(dim(t('cli:login.onlineTip')));
    await service.close();
  }
  const previous = config.server(server.url);
  if (previous) discard(previous.url, previous.token);
  const kept = values['no-save'] ? undefined : protect(server.url, token);
  config.remember(kept ? { ...server, token: kept } : server);
  if (!kept) say(t('cli:login.notSaved'));
  else if (kept.store === 'file') say(dim(t('cli:login.savedInFile', { path: config.path })));
}

const older = (a, b) => a.localeCompare(b, undefined, { numeric: true }) < 0;

// The service first, the way the desktop client upgrades it: it fetches its newest release and restarts. Then ccdt
// becomes the release of the service, which is what it can speak to: newer, or older where ccdt was ahead of it.
// The ccdt the desktop client carries is updated with the client, which offers the service's release when it connects.
// The client upgrades itself on Windows; elsewhere it is downloaded again.
const DESKTOP_UPGRADE = (next) =>
  process.platform === 'win32'
    ? t('cli:upgrade.withWindow', { version: next })
    : t('cli:upgrade.withWindowPage', { version: next, page: releasePage(next) });

async function upgrade(config, values) {
  const server = await target(config, values);
  const token = credentials(server);
  let current;
  try {
    const service = await signIn(config, values);
    current = service.version;
    await service.close();
  } catch (error) {
    // A service of another release says which it is.
    if (error.code !== 'version_mismatch' || !error.service) throw error;
    current = error.service;
  }
  let next = current;
  // A service newer than ccdt is not asked: this ccdt cannot tell which protocol it speaks.
  if (!older(version, current)) {
    say(dim(t('cli:upgrade.checking', { version: current })));
    let installing = false;
    // Sessions at work hold the upgrade back; a service that can be forced past them is, when asked to.
    const forcible = !older(current, FORCED_UPGRADE_SINCE);
    const attempt = (force) =>
      upgradeService(
        {
          url: server.url,
          fingerprint: server.fingerprint,
          token,
          deviceName: hostname(),
          service: current,
          force,
        },
        {
          resolveProxy: async (address) => proxyFor(address),
          confirm: async (latest) => {
            if (values.yes || force) return true;
            if (!process.stdin.isTTY) throw new Error(t('cli:upgrade.confirmFirst'));
            return (
              (await pick(t('cli:upgrade.question', { latest, current }), [
                t('cli:upgrade.yes'),
                t('cli:upgrade.no'),
              ])) === 0
            );
          },
          onUpdate: (update) => {
            if (update.state === 'installing' && !installing) say(dim(t('cli:upgrade.installing')));
            installing ||= update.state === 'installing';
          },
        },
      );
    try {
      try {
        next = await attempt(forcible && values.force);
      } catch (error) {
        if (error.code !== 'busy' || !forcible) throw error;
        const busy = failureText(error);
        if (!process.stdin.isTTY) throw new Error(t('cli:upgrade.forceHint', { busy }));
        if ((await pick(busy, [t('cli:upgrade.force'), t('cli:upgrade.no')])) !== 0)
          throw Object.assign(new Error(t('cli:upgrade.declined')), { code: 'declined' });
        next = await attempt(true);
      }
      say(t('cli:upgrade.restarting', { version: next }));
    } catch (error) {
      if (error.code === 'current') say(t('cli:upgrade.current', { version: current }));
      else if (error.code === 'declined' || error.code === 'manual') say(failureText(error));
      else throw error;
    }
  }
  if (next === version) {
    say(t('cli:upgrade.same', { version }));
    return 0;
  }
  if (older(next, FIRST_UPGRADABLE)) {
    say(
      t('cli:upgrade.tooOld', { first: FIRST_UPGRADABLE, page: releasePage(next), version: next }),
    );
    return 1;
  }
  if (!bundled) {
    say(t('cli:upgrade.fromSource', { version: next }));
    return 1;
  }
  if (desktop) {
    say(DESKTOP_UPGRADE(next));
    return 1;
  }
  say(dim(t('cli:upgrade.downloading', { version: next })));
  install(await download(next));
  say(t('cli:upgrade.done', { version: next }));
  say(dim(t('cli:upgrade.othersOld')));
  return 0;
}

// Asks the service to look for a newer release now and says what it found, for both sides.
async function check(config, values) {
  const service = await signIn(config, values, true, false);
  try {
    await service.request({ type: 'service.update.check' });
  } finally {
    await service.close();
  }
  const { update } = service;
  if (update?.state === 'failed')
    return (
      say(
        t('cli:check.failed', {
          reason: update.detail ? wordsOf(update.detail) : t('cli:check.unknown'),
        }),
      ),
      1
    );
  const found = newer(update);
  say(found ? `${t('cli:check.now', { version })}${found}` : t('cli:check.latest', { version }));
  return 0;
}

// The settings ccdt keeps in its own configuration.
const ownSetting = (name) => /^(ccdt|connection)\./.test(name ?? '');

// `ccdt config`: every setting with its value; with a name, that one; with a value too, sets it. In a terminal and
// without a name the list is gone through with the arrow keys, each value chosen or typed there.
async function configure(config, values, [name, ...words]) {
  let service;
  let remote = {};
  // ccdt's own settings need no service; the others are read from it.
  if (!ownSetting(name))
    try {
      // Settings are no reason to log in: without a service only this computer's are shown.
      if (!config.servers.length) throw new Error(t('cli:config.notSignedIn'));
      service = await signIn(config, values, true, false);
      remote = await readRemote(service);
    } catch (error) {
      if (name) throw error;
      say(dim(t('cli:config.localOnly', { reason: failureText(error) })));
    }
  const list = () => entries({ waits: config.waits, language: config.language, ...remote });
  try {
    if (name) {
      const entry = list().find((item) => item.name === name);
      if (!entry) throw new Error(t('cli:config.unknown', { name }));
      if (!words.length) {
        say(described(entry));
        return 0;
      }
      const value = parse(entry, words.join(' '));
      await save(entry, value, { config, service });
      // Read again, in the language it may have just chosen.
      const saved = list().find((item) => item.name === name);
      say(t('cli:config.value', { title: saved.title, value: shown({ ...saved, value }) }));
      return 0;
    }
    if (!process.stdin.isTTY) {
      say(table(list()));
      return 0;
    }
    for (let at = 0; ;) {
      const all = list();
      const chosen = await pick(
        t('cli:config.title'),
        all.map((entry) => `${pad(entry.title, 34)}${pad(shown(entry), 18)}${dim(entry.group)}`),
        process.stdin,
        process.stderr,
        { at, hint: t('cli:config.hint'), clear: true },
      );
      if (chosen === undefined) return 0;
      at = chosen;
      const entry = all[chosen];
      if (entry.kind === 'pending') {
        say(t('cli:settings.notHere', { title: entry.title, where: entry.where }));
        continue;
      }
      let value;
      const options = choices(entry);
      if (options) {
        const index = await pick(
          `${entry.title}${entry.detail ? dim(`  ${entry.detail}`) : ''}`,
          options.map(([, words]) => words),
          process.stdin,
          process.stderr,
          {
            at: Math.max(
              0,
              options.findIndex(([option]) => option === (entry.value ?? null)),
            ),
            hint: t('cli:config.choiceHint'),
            clear: true,
          },
        );
        if (index === undefined) continue;
        value = options[index][0];
      } else {
        if (entry.detail) say(dim(entry.detail));
        const typed = await readLine(
          t('cli:config.type', { title: entry.title }),
          entry.kind === 'seconds' ? String(entry.value ?? '') : entry.write(entry.value),
        );
        // The question goes from the screen once answered, as the lists do.
        process.stderr.write(`\x1b[${entry.detail ? 2 : 1}A\x1b[J`);
        if (typed === undefined) continue;
        try {
          value = parse(entry, typed);
        } catch (error) {
          say(failureText(error));
          continue;
        }
      }
      try {
        await save(entry, value, { config, service });
        if (service && !ownSetting(entry.name)) remote = await readRemote(service);
      } catch (error) {
        say(t('cli:config.notSaved', { reason: failureText(error) }));
      }
    }
  } finally {
    await service?.close().catch(() => {});
  }
}

// One setting, for `ccdt config <name>`: its value, what it does and what it can be.
function described(entry) {
  const options = choices(entry);
  return [
    t('cli:config.value', { title: entry.title, value: shown(entry) }),
    entry.detail && dim(entry.detail),
    entry.kind === 'pending' && entry.where,
    options &&
      t('cli:config.options', {
        options: options
          .map(([value, words]) =>
            t('cli:config.option', {
              value:
                value === null
                  ? 'default'
                  : typeof value === 'boolean'
                    ? value
                      ? 'on'
                      : 'off'
                    : value,
              words,
            }),
          )
          .join(t('cli:settings.separator')),
      }),
  ]
    .filter(Boolean)
    .join('\n');
}

// Every setting by its group, with the name to change it by.
function table(list) {
  const lines = [];
  for (const entry of list) {
    if (entry.group !== lines.group)
      lines.push(`${lines.length ? '\n' : ''}${(lines.group = entry.group)}`);
    lines.push(
      `  ${entry.name.padEnd(34)} ${t('cli:config.value', { title: entry.title, value: shown(entry) })}`,
    );
  }
  return [...lines, '', dim(t('cli:config.howTo'))].join('\n');
}

function listed(sessions) {
  return newest(sessions)
    .map(
      (session) =>
        `${session.id.slice(0, 8)}  ${when(session.updatedAt)}  ${session.title}${status(session)}\n          ${dim(`${session.projectPath}${session.device ? t('cli:sessions.device', { name: session.device.name }) : ''}`)}`,
    )
    .join('\n');
}

function usage(summary) {
  const lines = summary.windows.map((window) => {
    const name = quotaName(t, window.name) ?? window.name;
    return t(window.resetsAt ? 'cli:usage.lineReset' : 'cli:usage.line', {
      name: name.padEnd(8),
      used: window.utilization === null ? '—' : `${Math.round(window.utilization)}%`,
      reset: window.resetsAt ? when(window.resetsAt) : '',
      count: window.requests,
      cost: window.costUsd.toFixed(2),
    });
  });
  if (!lines.length) return t('cli:usage.none');
  return [...lines, dim(t('cli:usage.note'))].join('\n');
}

// Shows the session's terminal until it ends, taking it up again after the connection is lost. Closing the window
// ends it too, as it would a local CLI.
async function show(config, values, service, session, fresh) {
  const shown = {};
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    const ending = shown.terminalId
      ? service
          .request({ type: 'terminal.close', sessionId: session.id, terminalId: shown.terminalId })
          .catch(() => {})
      : Promise.resolve();
    await Promise.race([ending, new Promise((resolve) => setTimeout(resolve, 3000))]);
    await service.close().catch(() => {});
    process.exit(129);
  };
  // Windows sends SIGHUP when the console window is closed, and waits a few seconds before ending the process. On
  // Linux and macOS the terminal is gone with the window, and writing to it or reading from it fails, at times
  // before the signal arrives: that is the window closing too.
  process.once('SIGHUP', close);
  process.once('SIGTERM', close);
  for (const stream of [process.stdin, process.stdout]) stream.on('error', close);
  const project = projectOf(service.projects, session.device?.id, session.projectPath);
  // A plain session's folder is no project, as the desktop client tells it.
  const place = !project
    ? `${dim(t('cli:open.folder'))} ${session.projectPath}`
    : `${dim(t('cli:open.project'))} ${project.name ? `${project.name} ${dim(session.projectPath)}` : session.projectPath}`;
  say(
    `${place}  ${dim(t('cli:open.session'))} ${session.title}${fresh ? dim(t('cli:open.new')) : ''}`,
  );
  if (newer(service.update)) say(notice(newer(service.update)));
  // A terminal of ccdt is taken over; a run from the desktop client has to finish first.
  const run = service.sessions.get(session.id)?.activeRun;
  if (run && run.surface !== 'terminal') {
    await service.close();
    say(t('cli:open.busy'));
    return 1;
  }
  // While the terminal is shown the service looks for a new release at least hourly, as for a desktop window in use;
  // what it finds is said when the terminal ends.
  const look = () => {
    if (lookDue(service.update, Date.now()))
      void service.request({ type: 'service.update.check' }).catch(() => {});
  };
  look();
  const looking = setInterval(look, UPDATE_TICK_MS);
  looking.unref();
  try {
    return await showing();
  } finally {
    clearInterval(looking);
  }
  async function showing() {
    for (;;) {
      let result;
      let unwatch;
      try {
        if (service.tunnel) await service.channel();
        else
          try {
            // `ccdt online` carries this computer's commands; where it no longer does, this window opens a channel.
            await service.channel(5000);
          } catch (error) {
            if (service.ended) throw error;
            await service.close().catch(() => {});
            service = await signIn(config, values, true, true);
            await service.channel();
          }
        unwatch = service.tunnel ? undefined : shared(service);
        result = await relay(service, session.id, shown);
      } catch (error) {
        // Nothing to show, such as a terminal the service would not open: the connection is let go, for ccdt to end.
        await service.close().catch(() => {});
        throw error;
      }
      unwatch?.();
      log(`Terminal shown no longer: ${result.how}.`);
      if (result.how === 'exited') {
        await service.close();
        say(dim(t('cli:open.ended')));
        if (newer(service.update)) say(notice(newer(service.update)));
        return result.code ?? 0;
      }
      if (result.how === 'taken') {
        await service.close();
        say(t('cli:open.elsewhere'));
        return 0;
      }
      if (result.how === 'stalled') continue;
      // Let go for `ccdt online` gone: signed in again at once, with a channel of its own.
      const handover = service.handover;
      if (!handover) {
        process.stdout.write(`\x1b]0;${t('cli:open.reconnectingTitle')}\x07`);
        say(dim(`\r\n${t('cli:open.reconnecting')}`));
      }
      for (let wait = handover ? 0 : 1000; ; wait = Math.min(Math.max(wait * 2, 1000), 15000)) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        try {
          service = await signIn(config, values, true);
          break;
        } catch (error) {
          if (error.code === 'unauthorized' || error.code === 'version_mismatch') throw error;
        }
      }
    }
  }
}

// Commands reach this computer by `ccdt online` while it is there. Where they have not for a few seconds, the
// connection is let go (`handover`), for the window to sign in again with a channel of its own.
function shared(service) {
  let timer;
  const check = (message) => {
    if (message.type !== 'devices') return;
    if (message.devices.some((device) => device.id === service.deviceId && device.ready)) {
      clearTimeout(timer);
      timer = undefined;
    } else
      timer ??= setTimeout(() => {
        service.handover = true;
        service.end(true);
      }, 5000);
  };
  service.on('message', check);
  return () => {
    clearTimeout(timer);
    service.off('message', check);
  };
}

// With -p, -r takes a session as claude -p's does, where alone it opens the list to choose from.
export function printing(argv) {
  if (!argv.some((arg) => arg === '-p' || arg === '--print')) return argv;
  const args = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if ((arg === '-r' || arg === '--resume') && argv[index + 1] && !argv[index + 1].startsWith('-'))
      args.push('--session', argv[++index]);
    else args.push(arg);
  }
  return args;
}

const AGENT_COMMANDS = { status: statusOf, tell, wait, logs, stop, approve, deny, answer };

// What the commands for programs need of ccdt: a quiet sign-in, and this computer's execution channel kept for a run
// on it while they wait.
function agentContext(config, values) {
  const here = process.cwd();
  // Every connection made, let go of when the command ends however it ends: one left open keeps ccdt running.
  const made = new Set();
  const deviceId = config.device();
  const online = () => !!values.server && onlineAt(onlinePath(config), values.server);
  return {
    here,
    version,
    out: (text) => process.stdout.write(`${text}\n`),
    err: say,
    newest,
    mine: (session) => sameDirectory(session.projectPath, here),
    // Away from this computer the run needs nothing of this connection; here it needs a channel, ccdt online's
    // while that carries it.
    carried: (session) => (session.device && session.device.id !== deviceId) || online(),
    // Without `tunnel` a channel is opened as for a terminal: unless ccdt online carries this computer's.
    async connect(tunnel) {
      try {
        const service = await signIn(config, values, true, tunnel);
        made.add(service);
        return service;
      } catch (error) {
        throw Object.assign(error, { exit: error.exit ?? EXIT.connection });
      }
    },
    async keep(service, session) {
      if (session.device && session.device.id !== deviceId) return service;
      if (service.tunnel) {
        await service.channel();
        return service;
      }
      try {
        await service.channel(5000);
        // Where ccdt online stops carrying it, the connection is let go, to be made again with a channel of its own.
        shared(service);
        return service;
      } catch (error) {
        if (service.ended && error.exit) throw error;
        await service.close().catch(() => {});
        const again = await this.connect(true);
        await again.channel();
        return again;
      }
    },
    release: (service) => service.close().catch(() => {}),
    async done() {
      await Promise.all([...made].map((service) => service.close().catch(() => {})));
    },
  };
}

async function agentCommand(config, values, command, rest) {
  const context = agentContext(config, values);
  try {
    return await commandFor(context, values, command, rest);
  } finally {
    await context.done();
  }
}
async function commandFor(context, values, command, rest) {
  if (values.print) {
    let prompt = [command, ...rest].filter((word) => word !== undefined).join(' ');
    if (!prompt.trim() && !process.stdin.isTTY) {
      for await (const chunk of process.stdin) prompt += chunk;
    }
    return await printTask(context, values, prompt);
  }
  const [ref, ...words] = rest;
  if (command === 'tell') return await tell(context, values, ref, words.join(' '));
  if (command === 'deny') return await deny(context, values, ref, words.join(' '));
  if (command === 'answer') return await answer(context, values, ref, words);
  return await AGENT_COMMANDS[command](context, values, ref);
}

export async function main(argv) {
  const config = new Config();
  useLanguage(config.language);
  let parsed;
  try {
    parsed = parseArgs({
      args: printing(argv),
      allowPositionals: true,
      options: {
        resume: { type: 'boolean', short: 'r' },
        print: { type: 'boolean', short: 'p' },
        continue: { type: 'boolean', short: 'c' },
        session: { type: 'string' },
        bg: { type: 'boolean' },
        'output-format': { type: 'string' },
        'permission-mode': { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string' },
        title: { type: 'string' },
        timeout: { type: 'string' },
        last: { type: 'string' },
        mode: { type: 'string' },
        json: { type: 'boolean' },
        server: { type: 'string' },
        select: { type: 'boolean', short: 's' },
        fingerprint: { type: 'string' },
        'token-stdin': { type: 'boolean' },
        'no-save': { type: 'boolean' },
        'no-verify': { type: 'boolean' },
        all: { type: 'boolean' },
        check: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        force: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    say(`${error.message}\n\n${help()}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  let service;
  try {
    if (values.help) return (say(values.print ? agentHelp() : help()), 0);
    if (values.version) return (process.stdout.write(`ccdt ${version}\n`), 0);
    // With -p every word is the task, whatever command it happens to name.
    if (values.print) return await agentCommand(config, values, command, rest);
    if (command === 'help') return (say(rest[0] === 'agents' ? agentHelp() : help()), 0);
    if (command === 'login') return (await login(config, values, rest[0]), 0);
    if (command === 'upgrade') return await (values.check ? check : upgrade)(config, values);
    if (command === 'config') return await configure(config, values, rest);
    if (command === 'logout') return await logout(config, values);
    if (command === 'server') return await chooseServer(config, values);
    if (command === 'online') {
      let ended;
      const stop = new Promise((resolve) => (ended = resolve));
      // A terminal closed ends ccdt as it would any program; started with nohup it is not told.
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => ended());
      const code = await stayOnline({
        connect: (again) => signIn(config, values, again, true),
        say,
        stop,
        mark: (on) => markOnline(onlinePath(config), config.current)(on),
      });
      process.exit(code);
    }
    if (command === 'acp') {
      const context = agentContext(config, values);
      try {
        return await serveAcp(context);
      } finally {
        await context.done();
      }
    }
    if (AGENT_COMMANDS[command]) return await agentCommand(config, values, command, rest);
    if (command && !['new', 'open', 'sessions', 'usage'].includes(command))
      return (say(`${t('cli:unknownCommand', { command })}\n\n${help()}`), 2);
    // Listing sessions and usage runs no command on this computer.
    service = await signIn(
      config,
      values,
      !!values.json,
      ['sessions', 'usage'].includes(command) ? false : undefined,
    );
    const here = process.cwd();
    const all = [...service.sessions.values()];
    const mine = all.filter((session) => sameDirectory(session.projectPath, here));
    if (command === 'sessions' && values.json) {
      process.stdout.write(
        `${JSON.stringify(
          newest(values.all ? all : mine).map((session) => ({
            session_id: session.id,
            title: session.title,
            project: session.projectPath,
            ...(session.device ? { device: session.device.name } : {}),
            state: !session.activeRun
              ? 'idle'
              : session.activeRun.surface === 'terminal'
                ? 'terminal'
                : session.activeRun.status === 'awaiting_approval'
                  ? 'awaiting_approval'
                  : session.activeRun.waiting === 'background'
                    ? 'background'
                    : 'running',
            updated_at: session.updatedAt,
          })),
        )}\n`,
      );
      await service.close();
      return 0;
    }
    if (command === 'sessions') {
      const sessions = values.all ? all : mine;
      say(
        sessions.length
          ? listed(sessions)
          : values.all
            ? t('cli:sessions.none')
            : t('cli:sessions.noneHere'),
      );
      await service.close();
      return 0;
    }
    if (command === 'usage') {
      say(usage(await service.request({ type: 'usage.summary' })));
      await service.close();
      return 0;
    }
    let session;
    let fresh = false;
    if (command === 'open') {
      const prefix = rest[0]?.toLowerCase();
      const found = prefix ? all.filter((other) => other.id.startsWith(prefix)) : [];
      if (found.length !== 1) {
        await service.close();
        return (say(found.length ? t('cli:sessions.ambiguous') : t('cli:sessions.unknown')), 1);
      }
      session = found[0];
    } else if (values.resume) {
      const sessions = newest(values.all ? all : mine);
      if (!sessions.length) {
        await service.close();
        return (say(t('cli:sessions.noneToPick')), 1);
      }
      const chosen = await pick(
        values.all ? t('cli:sessions.pick') : t('cli:sessions.pickHere', { here }),
        sessions.map(
          (other) =>
            `${when(other.updatedAt).padEnd(12)} ${other.title}${status(other)}${values.all ? dim(`  ${other.projectPath}`) : ''}`,
        ),
      );
      if (chosen === undefined) {
        await service.close();
        return 0;
      }
      session = sessions[chosen];
    } else if (command !== 'new' && mine.length) session = newest(mine)[0];
    else {
      const response = await service.request({
        type: 'session.create',
        title: (rest.join(' ') || basename(here) || here).slice(0, 120),
        projectPath: here,
      });
      session = service.sessions.get(response.sessionId) ?? {
        id: response.sessionId,
        title: rest.join(' ') || basename(here),
        projectPath: here,
      };
      fresh = true;
    }
    return await show(config, values, service, session, fresh);
  } catch (error) {
    await service?.close().catch(() => {});
    say(failureText(error));
    if (error.exit !== undefined && error.code !== 'version_mismatch') return error.exit;
    // ccdt speaks the protocol of its own release, as the desktop client does. In a terminal it offers to become the
    // release of the service, or to upgrade the service first where ccdt is ahead of it.
    if (error.code === 'version_mismatch' && error.service) {
      if (process.stdin.isTTY && command !== 'upgrade') {
        const chosen = await pick(t('cli:mismatch.question', { version, service: error.service }), [
          older(version, error.service)
            ? t('cli:mismatch.switch', { version: error.service })
            : t('cli:mismatch.upgrade'),
          t('cli:mismatch.later'),
        ]).catch(() => undefined);
        if (chosen === 0)
          try {
            const code = await upgrade(config, values);
            if (!code) say(t('cli:mismatch.again'));
            return code;
          } catch (failure) {
            say(failureText(failure));
            return 1;
          }
      }
      say(
        desktop && older(version, error.service)
          ? DESKTOP_UPGRADE(error.service)
          : t('cli:mismatch.howTo', {
              version,
              service: error.service,
              page: releasePage(error.service),
            }),
      );
    }
    return 1;
  }
}
