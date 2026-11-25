import {
  cliSettingGroups,
  connectionWaits,
  idleCompactionFields,
  shellField,
  waitFields,
  waitRange,
} from '../../desktop/src/setting-fields.ts';
import { t } from './i18n.mjs';

// The settings ccdt changes, with the desktop client's words and choices: how this computer connects, which ccdt
// keeps for itself, and the service's own and Claude Code's, which the service keeps for every client. Each has a
// name for `ccdt config <name> <value>`. What a terminal does not lend itself to is listed as not here yet, with
// where to set it meanwhile.

// What may be typed for on, off and the default: the words of either language are taken.
const ON = ['on', 'true', 'yes', '1', '开', '开启'];
const OFF = ['off', 'false', 'no', '0', '关', '关闭'];
const DEFAULT = ['default', 'unset', '默认', ''];
const onOff = (value) => (value ? t('cli:settings.on') : t('cli:settings.off'));
const fallback = () => t('cli:settings.default');
const list = (items) => items.join(t('cli:settings.separator'));

// The service's settings that ccdt shows; one that cannot be read is left out, with why.
export async function readRemote(service) {
  const read = async (type) => {
    try {
      return (await service.request({ type })).values;
    } catch (error) {
      return { error: error.message };
    }
  };
  const [compaction, cli, web] = await Promise.all([
    read('compaction.get'),
    read('settings.get'),
    read('web.settings.get'),
  ]);
  // This computer as the service lists it, with its shells.
  const here = service.devices?.find((device) => device.id === service.deviceId);
  return { compaction, cli, web, here };
}

// Every setting with its current value. `waits` are ccdt's own, in seconds, a missing one taking the default.
export function entries({ waits = {}, compaction, cli, web, here } = {}) {
  const rows = waitFields(t).map(({ step, title, detail }) => ({
    name: `connection.${step}`,
    group: t('cli:settings.here'),
    title,
    detail: t('cli:settings.waitDetail', { detail, seconds: connectionWaits[step] }),
    kind: 'seconds',
    value: waits[step] ?? null,
    fallback: connectionWaits[step],
  }));
  // On Windows: Git Bash is listed whether or not this computer has it, and saved once it does.
  if (here && (here.platform ?? 'win32') === 'win32') {
    const has = (shell) => !!here.shells?.includes(shell);
    const shell = shellField(t);
    rows.push({
      name: 'device.shell',
      group: t('cli:settings.here'),
      ...shell,
      kind: 'choice',
      value: here.shell ?? null,
      options: shell.options.map(([name, words]) => [
        name,
        has(name) ? words : t('cli:settings.notFound', { words }),
      ]),
      available: shell.options.map(([name]) => name).filter(has),
      read: String,
    });
  }
  const usable = (values) => values && !values.error;
  const idle = idleCompactionFields(t);
  if (usable(compaction))
    rows.push(
      {
        name: 'compaction.enabled',
        group: t('cli:settings.server'),
        ...idle.enabled,
        kind: 'switch',
        value: compaction.enabled,
      },
      ...['afterMinutes', 'minTokens'].map((key) => {
        const field = idle[key];
        const name = (value) =>
          key === 'afterMinutes'
            ? t('cli:settings.minutes', { count: value })
            : `${value / 1000}K tokens`;
        return {
          name: `compaction.${key}`,
          group: t('cli:settings.server'),
          title: field.title,
          detail: field.detail,
          kind: 'choice',
          value: compaction[key],
          options: [...new Set([...field.options, compaction[key]])]
            .sort((a, b) => a - b)
            .map((value) => [String(value), name(value)]),
          read: Number,
        };
      }),
    );
  if (usable(web))
    rows.push({
      name: 'web.enabled',
      group: t('cli:settings.server'),
      title: t('cli:settings.web.title'),
      detail: web.url
        ? t('cli:settings.web.address', { url: web.url })
        : t('cli:settings.web.detail'),
      kind: 'switch',
      value: web.enabled,
    });
  rows.push({
    name: 'web.access',
    group: t('cli:settings.server'),
    title: t('cli:settings.web.access'),
    kind: 'pending',
    where: t('cli:settings.web.where'),
  });
  if (usable(cli))
    for (const group of cliSettingGroups(t, cli))
      for (const field of group.fields)
        rows.push({
          ...field,
          name: `cli.${field.key}`,
          group: `Claude Code · ${group.name}`,
          value: cli[field.key],
        });
  rows.push(
    {
      name: 'cli.instructions',
      group: 'Claude Code',
      title: t('cli:settings.instructions.title'),
      kind: 'pending',
      where: t('cli:settings.instructions.where'),
    },
    {
      name: 'cli.account',
      group: 'Claude Code',
      title: t('cli:settings.account.title'),
      kind: 'pending',
      where: t('cli:settings.account.where'),
    },
  );
  return rows;
}

// How a value reads in the list.
export function shown(entry) {
  const { kind, value } = entry;
  if (kind === 'pending') return t('cli:settings.pending');
  if (kind === 'seconds')
    return value === null
      ? t('cli:settings.secondsDefault', { seconds: entry.fallback })
      : t('cli:settings.seconds', { seconds: value });
  if (kind === 'switch') return onOff(value);
  if (value === null || value === undefined)
    return kind === 'toggle' || kind === 'choice' ? (entry.unset ?? fallback()) : fallback();
  if (kind === 'toggle') return onOff(value);
  if (kind === 'choice')
    return entry.options.find(([option]) => option === String(value))?.[1] ?? String(value);
  return entry.write(value) || fallback();
}

// The choices a value is picked from, as [value, words]; none for a value that is typed.
export function choices(entry) {
  if (entry.kind === 'switch')
    return [
      [true, onOff(true)],
      [false, onOff(false)],
    ];
  if (entry.kind === 'toggle')
    return [
      [null, entry.unset ?? fallback()],
      [true, onOff(true)],
      [false, onOff(false)],
    ];
  if (entry.kind === 'choice')
    return [
      ...(entry.unset ? [[null, entry.unset]] : []),
      ...entry.options.map(([option, words]) => [entry.read(option), words]),
    ];
  return undefined;
}

// The value written as `text` on the command line or typed in; an error says what would do.
export function parse(entry, text) {
  const word = String(text).trim();
  const lower = word.toLowerCase();
  if (entry.kind === 'pending')
    throw new Error(t('cli:settings.notHere', { title: entry.title, where: entry.where }));
  if (entry.kind !== 'switch' && DEFAULT.includes(lower)) return null;
  if (entry.kind === 'switch' || entry.kind === 'toggle') {
    if (ON.includes(lower)) return true;
    if (OFF.includes(lower)) return false;
    throw new Error(
      t(entry.kind === 'toggle' ? 'cli:settings.onOffDefault' : 'cli:settings.onOff', {
        title: entry.title,
      }),
    );
  }
  if (entry.kind === 'seconds') {
    const seconds = Number(word);
    if (Number.isInteger(seconds) && seconds >= waitRange.min && seconds <= waitRange.max)
      return seconds;
    throw new Error(
      t('cli:settings.secondsRange', {
        title: entry.title,
        min: waitRange.min,
        max: waitRange.max,
      }),
    );
  }
  if (entry.kind === 'choice') {
    const found = entry.options.find(
      ([option, words]) => option.toLowerCase() === lower || words === word,
    );
    if (found) return entry.read(found[0]);
    throw new Error(
      t('cli:settings.options', {
        title: entry.title,
        options: list([
          ...entry.options.map(([option]) => option),
          ...(entry.unset ? ['default'] : []),
        ]),
      }),
    );
  }
  return entry.read(word);
}

// Keeps a value: ccdt's own in its configuration, the service's by asking it, as the desktop client does.
export async function save(entry, value, { config, service }) {
  const [scope, key] = [
    entry.name.slice(0, entry.name.indexOf('.')),
    entry.name.slice(entry.name.indexOf('.') + 1),
  ];
  if (scope === 'connection') {
    const { [key]: _left, ...rest } = config.waits;
    config.waits = value === null ? rest : { ...rest, [key]: value };
    config.save();
    return;
  }
  if (!service) throw new Error(t('cli:settings.connectFirst'));
  if (scope === 'device') {
    if (value && !entry.available.includes(value)) throw new Error(shellField(t).missing);
    await service.request({ type: 'device.shell', shell: value });
    return;
  }
  const type = {
    compaction: 'compaction.update',
    web: 'web.settings.update',
    cli: 'settings.update',
  }[scope];
  await service.request({ type, values: { [key]: value } });
}
