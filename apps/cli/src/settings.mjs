import {
  cliSettingGroups,
  connectionWaits,
  idleCompactionFields,
  shellField,
  waitFields,
  waitRange,
} from '../../desktop/src/setting-fields.ts';

// The settings ccdt changes, with the desktop client's words and choices: how this computer connects, which ccdt
// keeps for itself, and the service's own and Claude Code's, which the service keeps for every client. Each has a
// name for `ccdt config <name> <value>`. What a terminal does not lend itself to is listed as not here yet, with
// where to set it meanwhile.

const ON = ['on', 'true', 'yes', '1', '开', '开启'];
const OFF = ['off', 'false', 'no', '0', '关', '关闭'];
const DEFAULT = ['default', 'unset', '默认', ''];
const onOff = (value) => (value ? '开启' : '关闭');

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
  const list = waitFields.map(({ step, title, detail }) => ({
    name: `connection.${step}`,
    group: '本机',
    title,
    detail: `${detail}。默认 ${connectionWaits[step]} 秒`,
    kind: 'seconds',
    value: waits[step] ?? null,
    fallback: connectionWaits[step],
  }));
  // On Windows: Git Bash is listed whether or not this computer has it, and saved once it does.
  if (here && (here.platform ?? 'win32') === 'win32') {
    const has = (shell) => !!here.shells?.includes(shell);
    list.push({
      name: 'device.shell',
      group: '本机',
      ...shellField,
      kind: 'choice',
      value: here.shell ?? null,
      options: shellField.options.map(([shell, words]) => [
        shell,
        has(shell) ? words : `${words}（未检测到）`,
      ]),
      available: shellField.options.map(([shell]) => shell).filter(has),
      read: String,
    });
  }
  const usable = (values) => values && !values.error;
  if (usable(compaction))
    list.push(
      {
        name: 'compaction.enabled',
        group: '服务端',
        ...idleCompactionFields.enabled,
        kind: 'switch',
        value: compaction.enabled,
      },
      ...['afterMinutes', 'minTokens'].map((key) => {
        const field = idleCompactionFields[key];
        const name = (value) =>
          key === 'afterMinutes' ? `${value} 分钟` : `${value / 1000}K tokens`;
        return {
          name: `compaction.${key}`,
          group: '服务端',
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
    list.push({
      name: 'web.enabled',
      group: '服务端',
      title: '浏览器访问',
      detail: web.url ? `访问地址 ${web.url}` : '在浏览器里使用这个服务端',
      kind: 'switch',
      value: web.enabled,
    });
  list.push({
    name: 'web.access',
    group: '服务端',
    title: '浏览器访问的地址、两步验证与证书',
    kind: 'pending',
    where: '在图形客户端的“设置 → 浏览器访问”里设置。',
  });
  if (usable(cli))
    for (const group of cliSettingGroups(cli))
      for (const field of group.fields)
        list.push({
          ...field,
          name: `cli.${field.key}`,
          group: `Claude Code · ${group.name}`,
          value: cli[field.key],
        });
  list.push(
    {
      name: 'cli.instructions',
      group: 'Claude Code',
      title: '全局说明（CLAUDE.md）',
      kind: 'pending',
      where: '在 Claude Code 里用 /memory 编辑，或在图形客户端的“设置 → 全局说明”里编辑。',
    },
    {
      name: 'cli.account',
      group: 'Claude Code',
      title: 'Claude 账号',
      kind: 'pending',
      where: '在 Claude Code 里用 /login、/logout，或在图形客户端的“设置 → 账号与额度”里。',
    },
  );
  return list;
}

// How a value reads in the list.
export function shown(entry) {
  const { kind, value } = entry;
  if (kind === 'pending') return '暂不支持';
  if (kind === 'seconds') return value === null ? `${entry.fallback} 秒（默认）` : `${value} 秒`;
  if (kind === 'switch') return onOff(value);
  if (value === null || value === undefined)
    return kind === 'choice' ? (entry.unset ?? '默认') : '默认';
  if (kind === 'toggle') return onOff(value);
  if (kind === 'choice')
    return entry.options.find(([option]) => option === String(value))?.[1] ?? String(value);
  return entry.write(value) || '默认';
}

// The choices a value is picked from, as [value, words]; none for a value that is typed.
export function choices(entry) {
  if (entry.kind === 'switch')
    return [
      [true, '开启'],
      [false, '关闭'],
    ];
  if (entry.kind === 'toggle')
    return [
      [null, '默认'],
      [true, '开启'],
      [false, '关闭'],
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
    throw new Error(`${entry.title}暂不支持在 ccdt 里设置：${entry.where}`);
  if (entry.kind !== 'switch' && DEFAULT.includes(lower)) return null;
  if (entry.kind === 'switch' || entry.kind === 'toggle') {
    if (ON.includes(lower)) return true;
    if (OFF.includes(lower)) return false;
    throw new Error(
      `${entry.title}只能是 on 或 off${entry.kind === 'toggle' ? '，或 default' : ''}。`,
    );
  }
  if (entry.kind === 'seconds') {
    const seconds = Number(word);
    if (Number.isInteger(seconds) && seconds >= waitRange.min && seconds <= waitRange.max)
      return seconds;
    throw new Error(
      `${entry.title}要填 ${waitRange.min}–${waitRange.max} 之间的整数秒，或 default。`,
    );
  }
  if (entry.kind === 'choice') {
    const found = entry.options.find(
      ([option, words]) => option.toLowerCase() === lower || words === word,
    );
    if (found) return entry.read(found[0]);
    throw new Error(
      `${entry.title}可选：${entry.options.map(([option]) => option).join('、')}${entry.unset ? '、default' : ''}。`,
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
  if (!service) throw new Error('改服务端的设置要先连上服务端。');
  if (scope === 'device') {
    if (value && !entry.available.includes(value)) throw new Error(shellField.missing);
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
