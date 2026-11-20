import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  escapeHtml,
  fillPush,
  pushChannelConfigSchema,
  pushSecrets,
  pushSettingsSchema,
  pushVariables,
  renderPush,
} from '@cc-desk-tunnel/protocol';
import type {
  EventPayload,
  NativeMetrics,
  PushChannel,
  PushChannelConfig,
  PushKind,
  PushOptions,
  PushSettings,
  PushState,
  Session,
} from '@cc-desk-tunnel/protocol';
import { DomainError } from './errors.ts';

export const PUSH: PushSettings = {
  enabled: false,
  events: { approval: true, question: true, done: true, failed: true },
  defaultMode: 'off',
  fallback: false,
  delayMinutes: 0,
  timeZone: 'UTC',
  channels: [],
};

const file = (directory: string) => join(directory, 'push.json');

// The service's own setting, kept with its sessions; it holds the channels' secrets, so only the service reads it.
// A file it cannot read is the defaults.
export function readPush(directory: string): PushSettings {
  try {
    return pushSettingsSchema.parse({
      ...PUSH,
      ...JSON.parse(readFileSync(file(directory), 'utf8')),
    });
  } catch {
    return structuredClone(PUSH);
  }
}
function writePush(directory: string, settings: PushSettings) {
  const next = pushSettingsSchema.parse(settings);
  writeFileSync(`${file(directory)}.new`, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  // Windows refuses the rename now and then while something, as a virus scan, still holds the file just written. The
  // service runs on Linux, but its tests and the development service run here, and a switch saves at each click.
  for (let attempt = 1; ; attempt++)
    try {
      renameSync(`${file(directory)}.new`, file(directory));
      return next;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM' || attempt === 5) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * attempt);
    }
}

// The variables of a push (`pushVariables`), each there even without a value, so that a line of one is left out.
export type PushValues = Record<string, string | undefined>;

const headings: Record<PushKind, string> = {
  approval: '等待审批',
  question: 'Claude 有问题要问你',
  done: '任务完成',
  failed: '任务失败',
};
const json = (url: string, body: unknown) => ({
  url,
  init: {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  },
});
// Where a push leads: {url} as it is, the other variables as parts of an address. Nothing where it comes to nothing.
const address = (template: string, values: PushValues) =>
  fillPush(
    template,
    Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name,
        name === 'url' || !value ? value : encodeURIComponent(value),
      ]),
    ),
  ).trim();

// The request each service takes for the channel's format, as its documentation has it. A format with no title of its
// own begins with the title; DingTalk's markdown keeps a line a paragraph, as a single line break does not show there.
export function pushRequest(
  config: PushChannelConfig,
  values: PushValues,
  now = Date.now(),
): { url: string; init: RequestInit } {
  if (config.kind === 'webhook') {
    const url = fillPush(config.url, values, encodeURIComponent);
    if (!config.body.trim()) return { url, init: { method: 'GET' } };
    // Filled in as JSON strings are written, so that the body stays the JSON it was.
    const body = fillPush(config.body, values, (value) => JSON.stringify(value).slice(1, -1));
    return { url, init: { method: 'POST', headers: { 'content-type': 'application/json' }, body } };
  }
  const escaped =
    (config.kind === 'telegram' || config.kind === 'pushplus') && config.format === 'html';
  const title =
    renderPush(config.title, values).split('\n')[0] || `「${values.event}」${values.session}`;
  const body = renderPush(config.body, values, escaped ? escapeHtml : undefined);
  const plain = [title, body].filter(Boolean).join('\n');
  switch (config.kind) {
    case 'dingtalk': {
      const url = new URL(config.url);
      if (config.secret) {
        url.searchParams.set('timestamp', String(now));
        url.searchParams.set(
          'sign',
          createHmac('sha256', config.secret).update(`${now}\n${config.secret}`).digest('base64'),
        );
      }
      const text = [`**${title}**`, ...body.split('\n')].join('\n\n');
      const button = address(config.buttonUrl, values);
      if (config.format === 'text')
        return json(url.toString(), { msgtype: 'text', text: { content: plain } });
      if (config.format === 'actionCard' && button)
        return json(url.toString(), {
          msgtype: 'actionCard',
          actionCard: { title, text, singleTitle: config.button || '打开', singleURL: button },
        });
      return json(url.toString(), { msgtype: 'markdown', markdown: { title, text } });
    }
    case 'feishu': {
      // Feishu signs with the timestamp and secret as the key, over nothing.
      const timestamp = String(Math.floor(now / 1000));
      const sign = config.secret
        ? {
            timestamp,
            sign: createHmac('sha256', `${timestamp}\n${config.secret}`).digest('base64'),
          }
        : {};
      return json(
        config.url,
        config.format === 'text'
          ? { ...sign, msg_type: 'text', content: { text: plain } }
          : {
              ...sign,
              msg_type: 'interactive',
              card: {
                header: { title: { tag: 'plain_text', content: title } },
                elements: [{ tag: 'markdown', content: body }],
              },
            },
      );
    }
    case 'wecom':
      return json(
        config.url,
        config.format === 'text'
          ? { msgtype: 'text', text: { content: plain } }
          : { msgtype: 'markdown', markdown: { content: `**${title}**\n${body}` } },
      );
    case 'telegram':
      return json(`https://api.telegram.org/bot${config.token}/sendMessage`, {
        chat_id: config.chatId,
        ...(escaped
          ? {
              parse_mode: 'HTML',
              text: [`<b>${escapeHtml(title)}</b>`, body].filter(Boolean).join('\n'),
            }
          : { text: plain }),
      });
    case 'pushplus':
      return json('https://www.pushplus.plus/send', {
        token: config.token,
        title,
        content: body,
        template: config.format === 'text' ? 'txt' : config.format,
        ...(config.channel ? { channel: config.channel } : {}),
        ...(config.topic ? { topic: config.topic } : {}),
      });
    case 'bark': {
      const click = address(config.clickUrl, values);
      return json(config.url, {
        title,
        body,
        group: 'CC Desk Tunnel',
        ...(click ? { url: click } : {}),
      });
    }
  }
}

// The robots, and PushPlus, answer a refused message with HTTP 200 and a code of their own in the body.
async function deliver(config: PushChannelConfig, values: PushValues) {
  const { url, init } = pushRequest(config, values);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    // The error of a failed fetch names no address, which may hold a key, but its cause says why.
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    throw new Error(cause?.code ?? cause?.message ?? (error as Error).message);
  }
  const body = await response.text();
  let reply: { errcode?: number; errmsg?: string; code?: number; msg?: string } | undefined;
  try {
    reply = JSON.parse(body);
  } catch {
    reply = undefined;
  }
  const refused =
    config.kind === 'dingtalk' || config.kind === 'wecom'
      ? reply?.errcode !== 0
      : config.kind === 'feishu'
        ? reply?.code !== 0
        : config.kind === 'pushplus' && reply?.code !== 200;
  // What the service said of it, and no more: a body read back as it came could be any page the address leads to,
  // or repeat what the request was sent with.
  if (!response.ok || refused)
    throw new Error(
      [
        response.ok ? '' : `HTTP ${response.status}`,
        String(reply?.errmsg ?? reply?.msg ?? '').slice(0, 200),
      ]
        .filter(Boolean)
        .join(' ') || '渠道没有接受这条消息',
    );
}

// Month, day and time where the user is.
function when(at: string | number, timeZone: string) {
  const part = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(at))
      .map(({ type, value }) => [type, value]),
  );
  return `${part.month}-${part.day} ${part.hour}:${part.minute}`;
}
function lasted(ms: number) {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${seconds} 秒`;
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
// claude-opus-5-5 is Opus 5.5; a name of another form is shown as it is.
function modelName(model: string) {
  const parts = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(model);
  return parts ? `${parts[1][0].toUpperCase()}${parts[1].slice(1)} ${parts[2]}.${parts[3]}` : model;
}
// The weekly windows a plan keeps for one model, and the model each is for: `seven_day_opus`, `seven_day:Fable` as
// the plan names it, or one a long-lived token's replies leave unnamed.
function modelWindow(name: string) {
  if (name.startsWith('seven_day:')) return name.slice(10);
  if (name === 'seven_day_opus') return 'Opus';
  if (name === 'seven_day_sonnet') return 'Sonnet';
  if (name === 'seven_day_overage_included') return '按模型';
  return undefined;
}
// What the session's last reading says of its model and the plan quota. Of the windows a plan keeps for one model,
// the one for the session's model if it has one, or else the fullest: a plan may keep one for a model the session
// does not use, as Fable on Max, which is still the one worth a glance.
function readings(metrics: NativeMetrics | null | undefined, timeZone: string) {
  const model = metrics?.context?.model;
  const read = metrics?.rateLimits?.available
    ? metrics.rateLimits.windows.filter((window) => window.utilization !== null)
    : [];
  const used = (window?: (typeof read)[number]) =>
    window ? `${Math.round(window.utilization!)}%` : undefined;
  const hour = read.find((window) => window.name === 'five_hour');
  const family = model && /^claude-([a-z]+)/.exec(model)?.[1];
  const perModel = read
    .filter((window) => modelWindow(window.name))
    .sort((a, b) => b.utilization! - a.utilization!);
  const own =
    perModel.find((window) => family && modelWindow(window.name)!.toLowerCase() === family) ??
    perModel[0];
  const week = read.find((window) => window.name === 'seven_day');
  const reset = (window?: (typeof read)[number]) =>
    window?.resetsAt ? when(window.resetsAt, timeZone) : undefined;
  return {
    model: model ? modelName(model) : undefined,
    quota5h: used(hour),
    quota5hReset: reset(hour),
    quotaWeek: used(week),
    quotaWeekReset: reset(week),
    quotaModel: used(own),
    quotaModelName: own && modelWindow(own.name),
    quotaModelReset: reset(own),
  };
}

type Hooks = {
  session: (sessionId: string) => Session | undefined;
  // When the session's run began, and its last reading of the model and the quota.
  facts: (sessionId: string) => { startedAt?: number; metrics?: NativeMetrics | null };
  // The page a browser opens, while the service serves browsers; a session is a place on it.
  page: () => string | undefined;
  // A turn ended that a `once` subscription was for; the session is sent on with its run's status.
  ended: (sessionId: string) => void;
  changed: (state: PushState) => void;
  deliver?: typeof deliver;
};

// Watches the runs of the chat for what a user away from every window would want to know — a run ended, or it waits
// for an answer — and sends it to every channel switched on, each as its own template says: for a session subscribed
// to, at once; for the others, only approvals and questions, if the setting asks, and after the delay it sets if no
// window answered them by then.
export class Pushes {
  settings: PushSettings;
  private failures = new Map<string, { at: string; message: string }>();
  // The last error each session's run reported, which its failure says.
  private errors = new Map<string, string>();
  private waits = new Map<string, NodeJS.Timeout>();
  private directory: string;
  private hooks: Hooks;
  constructor(directory: string, hooks: Hooks) {
    this.directory = directory;
    this.hooks = hooks;
    this.settings = readPush(directory);
  }

  // Every window, a browser's too, is told each channel's config without what it sends with.
  state(): PushState {
    const { channels, ...options } = this.settings;
    return {
      ...options,
      channels: channels.map(({ id, name, enabled, config }) => {
        const secret = pushSecrets[config.kind];
        const entries = Object.entries(config) as [string, string][];
        return {
          id,
          name,
          kind: config.kind,
          enabled,
          config: Object.fromEntries(entries.filter(([key]) => !secret.includes(key))),
          secrets: entries.filter(([key]) => secret.includes(key)).map(([key]) => key),
          ...(this.failures.has(id) ? { failure: this.failures.get(id) } : {}),
        };
      }),
    };
  }
  update(values: Partial<PushOptions>) {
    return this.save({ ...this.settings, ...values });
  }
  // Adds a channel, or changes one: a field it sends with that the change leaves out or empty is kept, and null takes
  // an optional one away. A channel that becomes another kind is given anew.
  put(channelId: string | undefined, name: string, input: Record<string, string | null>) {
    const existing = channelId ? this.channel(channelId) : undefined;
    const kept: Record<string, unknown> =
      existing?.config.kind === input.kind ? existing.config : {};
    const config: Record<string, unknown> = { ...input };
    for (const key of pushSecrets[input.kind as PushChannelConfig['kind']] ?? []) {
      if (config[key] === null) delete config[key];
      else if (!config[key]) {
        if (kept[key] === undefined) delete config[key];
        else config[key] = kept[key];
      }
    }
    const parsed = pushChannelConfigSchema.safeParse(config);
    if (!parsed.success)
      throw new DomainError(
        'push_channel_invalid',
        `渠道设置不完整或有误：${[...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))].join('、')}`,
      );
    const channel = existing
      ? { ...existing, name, config: parsed.data }
      : { id: randomUUID(), name, enabled: true, config: parsed.data };
    if (existing) this.failures.delete(existing.id);
    return this.save({
      ...this.settings,
      channels: existing
        ? this.settings.channels.map((item) => (item.id === existing.id ? channel : item))
        : [...this.settings.channels, channel],
    });
  }
  enable(channelId: string, enabled: boolean) {
    this.channel(channelId);
    return this.save({
      ...this.settings,
      channels: this.settings.channels.map((channel) =>
        channel.id === channelId ? { ...channel, enabled } : channel,
      ),
    });
  }
  remove(channelId: string) {
    this.failures.delete(channelId);
    return this.save({
      ...this.settings,
      channels: this.settings.channels.filter((channel) => channel.id !== channelId),
    });
  }
  // Sends whether or not pushes or the channel are switched on, and says why it failed: the channel's own template,
  // filled with the samples the settings page shows, and the page a browser opens for its link.
  async test(channelId: string) {
    const values: PushValues = Object.fromEntries(
      pushVariables.map(({ name, sample }) => [name, sample]),
    );
    values.event = '测试推送';
    values.url = this.hooks.page();
    const failure = await this.send(this.channel(channelId), values);
    if (failure) throw new DomainError('push_failed', `发送失败：${failure}`);
  }

  // Each payload a chat run emits, once it is recorded. Unlike the window's own notices, a run is not done while
  // only background tasks go on: Claude mostly waits there for a build or tests and goes on by itself once they end,
  // and a `once` subscription spent on that pause would miss the end it was for. A run held open by a task that never
  // ends, such as a server kept in a background shell, is not pushed as done; its approvals and questions still are.
  observe(sessionId: string, payload: EventPayload) {
    if (payload.type === 'run.error') this.errors.set(sessionId, payload.message);
    // An answer ends the wait only once none is left to answer, which the run says with its status.
    if (payload.type !== 'run.status') return;
    this.unwait(sessionId);
    const session = this.hooks.session(sessionId);
    if (!session) return;
    const ended = payload.status !== 'running' && payload.status !== 'awaiting_approval';
    const kind: PushKind | undefined =
      payload.status === 'awaiting_approval'
        ? payload.waiting === 'question'
          ? 'question'
          : 'approval'
        : payload.status === 'completed'
          ? 'done'
          : payload.status === 'failed'
            ? 'failed'
            : undefined;
    if (kind && session.push) this.push(session, kind);
    else if ((kind === 'approval' || kind === 'question') && this.settings.fallback) {
      if (!this.settings.delayMinutes) this.push(session, kind);
      else {
        const wait = setTimeout(() => {
          this.waits.delete(sessionId);
          const now = this.hooks.session(sessionId);
          // The setting may have been switched off meanwhile.
          if (this.settings.fallback && now?.activeRun?.status === 'awaiting_approval')
            this.push(now, kind);
        }, this.settings.delayMinutes * 60_000);
        wait.unref();
        this.waits.set(sessionId, wait);
      }
    }
    if (ended) this.errors.delete(sessionId);
    if (ended && session.push === 'once') this.hooks.ended(sessionId);
  }
  close() {
    for (const wait of this.waits.values()) clearTimeout(wait);
    this.waits.clear();
  }

  private push(session: Session, kind: PushKind) {
    if (!this.settings.enabled || !this.settings.events[kind]) return;
    const { timeZone } = this.settings;
    const { startedAt, metrics } = this.hooks.facts(session.id);
    const page = this.hooks.page();
    const values: PushValues = {
      event: headings[kind],
      session: session.title,
      device: session.device?.name,
      project: session.projectPath.split(/[\\/]/).filter(Boolean).at(-1),
      duration: startedAt === undefined ? undefined : lasted(Date.now() - startedAt),
      time: when(Date.now(), timeZone),
      error: kind === 'failed' ? this.errors.get(session.id) : undefined,
      ...readings(metrics, timeZone),
      url: page && `${page}#session=${session.id}`,
    };
    for (const channel of this.settings.channels)
      if (channel.enabled) void this.send(channel, values);
  }
  // The reason it failed, or nothing once it was sent. Only a change of the failures is told to the windows.
  private async send(channel: PushChannel, values: PushValues) {
    try {
      await (this.hooks.deliver ?? deliver)(channel.config, values);
      if (this.failures.delete(channel.id)) this.hooks.changed(this.state());
      return undefined;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`Push to "${channel.name}" failed: ${reason}`);
      this.failures.set(channel.id, { at: new Date().toISOString(), message: reason });
      this.hooks.changed(this.state());
      return reason;
    }
  }
  private channel(channelId: string) {
    const channel = this.settings.channels.find((item) => item.id === channelId);
    if (!channel) throw new DomainError('not_found', '推送渠道不存在。');
    return channel;
  }
  private unwait(sessionId: string) {
    clearTimeout(this.waits.get(sessionId));
    this.waits.delete(sessionId);
  }
  private save(settings: PushSettings) {
    this.settings = writePush(this.directory, settings);
    return this.state();
  }
}
