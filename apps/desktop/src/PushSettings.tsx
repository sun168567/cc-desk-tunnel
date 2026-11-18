import { useEffect, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import {
  escapeHtml,
  fillPush,
  pushDefaults,
  pushFormats,
  pushSecrets,
  pushVariables,
  renderPush,
} from '@cc-desk-tunnel/protocol';
import type { PushChannelKind, PushOptions, PushState } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { DialogForm, IconButton, Row, Switch } from './ui.tsx';

type Channel = PushState['channels'][number];
type Field = { key: string; label: string; placeholder?: string; optional?: boolean };
const webhookUrl = (placeholder: string): Field => ({
  key: 'url',
  label: 'Webhook 地址',
  placeholder,
});
// Where each kind of channel sends: the fields of `pushSecrets` are not shown again once given.
const kinds: Record<PushChannelKind, { name: string; fields: Field[] }> = {
  dingtalk: {
    name: '钉钉机器人',
    fields: [
      webhookUrl('https://oapi.dingtalk.com/robot/send?access_token=…'),
      { key: 'secret', label: '加签密钥', placeholder: 'SEC…', optional: true },
    ],
  },
  feishu: {
    name: '飞书机器人',
    fields: [
      webhookUrl('https://open.feishu.cn/open-apis/bot/v2/hook/…'),
      { key: 'secret', label: '签名校验密钥', optional: true },
    ],
  },
  wecom: {
    name: '企业微信群机器人',
    fields: [webhookUrl('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…')],
  },
  telegram: {
    name: 'Telegram Bot',
    fields: [
      { key: 'token', label: 'Bot Token', placeholder: '123456:ABC…' },
      { key: 'chatId', label: 'Chat ID' },
    ],
  },
  pushplus: {
    name: 'PushPlus',
    fields: [
      { key: 'token', label: 'Token', placeholder: '建议用 PushPlus 后台的消息 token' },
      { key: 'topic', label: '群组编码', placeholder: '一对多推送时填写', optional: true },
    ],
  },
  bark: {
    name: 'Bark',
    fields: [{ key: 'url', label: 'Bark 地址', placeholder: 'https://api.day.app/你的 Key' }],
  },
  webhook: {
    name: '通用 Webhook',
    fields: [{ key: 'url', label: '地址', placeholder: 'https://…' }],
  },
};
const delays = [0, 1, 2, 5, 10, 15, 30, 60];
const events: { key: keyof PushOptions['events']; title: string; detail: string }[] = [
  { key: 'approval', title: '等待审批', detail: '有操作需要你允许或拒绝' },
  { key: 'question', title: 'Claude 提问', detail: 'Claude 需要你回答问题才能继续' },
  { key: 'done', title: '任务完成', detail: 'Claude Code 做完了一次运行' },
  { key: 'failed', title: '任务失败', detail: '运行因错误而结束' },
];
// Times in a push read as where the user is; every change from a window says where that is.
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// The service's pushes to a chat robot or a phone app, for when no window is in front of the user. A browser sets
// them as the desktop does: what a channel sends with is never shown again, in either.
export default function PushSettings({ client }: { client: ProxyClient }) {
  const [values, setValues] = useState<PushState | null>(client.state.push);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Channel | 'new' | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    client.fetch({ type: 'push.get' }).then(
      (reply) => current && setValues(reply.values),
      (error: Error) => current && setFailure(error.message),
    );
    // A test's failure, or another window's change, is told to every window.
    const unsubscribe = client.subscribe(() => current && setValues(client.state.push));
    return () => {
      current = false;
      unsubscribe();
    };
  }, [client]);
  async function run(task: () => Promise<unknown>) {
    setFailure(null);
    setSaving(true);
    try {
      await task();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '保存失败。');
    } finally {
      setSaving(false);
    }
  }
  const save = (change: Partial<PushOptions>) =>
    run(() => client.fetch({ type: 'push.update', values: { ...change, timeZone: timeZone() } }));
  if (!values)
    return failure ? (
      <p className="error-text" role="alert">
        {failure}
      </p>
    ) : null;
  return (
    <>
      {failure && (
        <p className="error-text" role="alert">
          {failure}
        </p>
      )}
      <div className="settings-list card">
        <Row title="开启外部推送" detail="关闭后所有会话都不推送，订阅保留">
          <Switch
            label="开启外部推送"
            checked={values.enabled}
            disabled={saving}
            onChange={(enabled) => void save({ enabled })}
          />
        </Row>
        <label>
          <span>
            <strong>新会话默认订阅</strong>
            <small>新建和分叉出的会话从这里开始，之后在输入框旁的铃铛里改</small>
          </span>
          <select
            aria-label="新会话默认订阅"
            disabled={saving}
            value={values.defaultMode}
            onChange={({ target }) => void save({ defaultMode: target.value as 'off' | 'always' })}
          >
            <option value="off">不订阅</option>
            <option value="always">持续</option>
          </select>
        </label>
      </div>

      <h2 className="page-heading">推送哪些事</h2>
      <div className="card">
        {events.map(({ key, title, detail }) => (
          <Row key={key} title={title} detail={detail}>
            <Switch
              label={title}
              checked={values.events[key]}
              disabled={saving}
              onChange={(value) => void save({ events: { ...values.events, [key]: value } })}
            />
          </Row>
        ))}
      </div>

      <h2 className="page-heading">未订阅的会话</h2>
      <div className="settings-list card">
        <Row title="也推送审批和提问" detail="会话卡在等你回答时，即使没有订阅也推送">
          <Switch
            label="未订阅的会话也推送审批和提问"
            checked={values.fallback}
            disabled={saving}
            onChange={(fallback) => void save({ fallback })}
          />
        </Row>
        <label>
          <span>
            <strong>延迟推送</strong>
            <small>等待这么久仍没有在任何窗口处理，才推送</small>
          </span>
          <select
            aria-label="延迟推送"
            disabled={saving || !values.fallback}
            value={String(values.delayMinutes)}
            onChange={({ target }) => void save({ delayMinutes: Number(target.value) })}
          >
            {[...new Set([...delays, values.delayMinutes])]
              .sort((a, b) => a - b)
              .map((value) => (
                <option key={value} value={value}>
                  {value ? `${value} 分钟` : '不延迟'}
                </option>
              ))}
          </select>
        </label>
      </div>

      <h2 className="page-heading">推送渠道</h2>
      <div className="card">
        {values.channels.length === 0 && <p className="muted push-empty">还没有推送渠道。</p>}
        {values.channels.map((channel) => (
          <Row
            key={channel.id}
            title={channel.name}
            detail={
              channel.failure ? (
                <span className="error-text">
                  上次发送失败（{new Date(channel.failure.at).toLocaleString()}）：
                  {channel.failure.message}
                </span>
              ) : tested === channel.id ? (
                '测试推送已发出'
              ) : (
                [
                  kinds[channel.kind].name,
                  pushFormats[channel.kind].find((item) => item.value === channel.config.format)
                    ?.label,
                ]
                  .filter(Boolean)
                  .join(' · ')
              )
            }
          >
            <div className="setting-actions">
              <button
                type="button"
                className="button"
                disabled={saving}
                onClick={() =>
                  void run(async () => {
                    setTested(null);
                    await client.request({ type: 'push.test', channelId: channel.id });
                    setTested(channel.id);
                  })
                }
              >
                测试
              </button>
              <IconButton
                title={`编辑 ${channel.name}`}
                disabled={saving}
                onClick={() => setEditing(channel)}
              >
                <Pencil />
              </IconButton>
              <IconButton
                title={`删除 ${channel.name}`}
                disabled={saving}
                onClick={() =>
                  void run(() =>
                    client.fetch({ type: 'push.channel.delete', channelId: channel.id }),
                  )
                }
              >
                <Trash2 />
              </IconButton>
              <Switch
                label={`启用 ${channel.name}`}
                checked={channel.enabled}
                disabled={saving}
                onChange={(enabled) =>
                  void run(() =>
                    client.fetch({ type: 'push.channel.enable', channelId: channel.id, enabled }),
                  )
                }
              />
            </div>
          </Row>
        ))}
      </div>
      <button type="button" className="button" disabled={saving} onClick={() => setEditing('new')}>
        <Plus />
        添加渠道
      </button>
      {editing && (
        <ChannelDialog
          channel={editing === 'new' ? null : editing}
          save={async (name, config) => {
            if (editing === 'new') await client.fetch({ type: 'push.channel.add', name, config });
            else
              await client.fetch({
                type: 'push.channel.update',
                channelId: editing.id,
                name,
                config,
              });
            setEditing(null);
          }}
          close={() => setEditing(null)}
        />
      )}
    </>
  );
}

// Adds a channel, or changes one. What it sends with starts empty when it is changed, and is kept if left so; an
// optional one can be taken away. Its content is written in its format, with the variables of a push.
function ChannelDialog({
  channel,
  save,
  close,
}: {
  channel: Channel | null;
  save: (
    name: string,
    config: { kind: PushChannelKind } & Record<string, string | null>,
  ) => Promise<void>;
  close: () => void;
}) {
  const [kind, setKind] = useState<PushChannelKind>(channel?.kind ?? 'dingtalk');
  const [name, setName] = useState(channel?.name ?? '');
  const [fields, setFields] = useState<Record<string, string>>(
    channel ? channel.config : pushDefaults('dingtalk'),
  );
  const [cleared, setCleared] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const secrets = pushSecrets[kind];
  const set = (key: string, value: string) =>
    setFields((current) => ({ ...current, [key]: value }));
  const has = (key: string) => !!channel?.secrets.includes(key) && !cleared.includes(key);
  // A content left as the old format had it becomes the new one's; what the user wrote stays.
  function format(next: string) {
    const before = pushDefaults(kind, fields.format);
    const after = pushDefaults(kind, next);
    setFields((current) => ({
      ...current,
      ...Object.fromEntries(
        Object.entries(after).filter(
          ([key]) => current[key] === undefined || current[key] === before[key],
        ),
      ),
      format: next,
    }));
  }
  async function submit() {
    const missing = kinds[kind].fields.filter(
      ({ key, optional }) => !optional && !fields[key]?.trim() && !has(key),
    );
    if (missing.length) return setError(`请填写：${missing.map(({ label }) => label).join('、')}`);
    setBusy(true);
    setError('');
    try {
      const config: { kind: PushChannelKind } & Record<string, string | null> = { kind };
      for (const [key, value] of Object.entries(fields))
        if (!secrets.includes(key) || value.trim()) config[key] = value;
      for (const key of cleared) config[key] = null;
      await save(name.trim() || kinds[kind].name, config);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败。');
      setBusy(false);
    }
  }
  const samples = Object.fromEntries(pushVariables.map(({ name, sample }) => [name, sample]));
  // A page PushPlus shows is shown as one, in a frame that runs nothing of it.
  // Nor does it load what the template points at: no address, only its own styles and inline pictures.
  const page =
    kind === 'pushplus' && fields.format === 'html'
      ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">${renderPush(fields.body ?? '', samples, escapeHtml)}`
      : null;
  const preview =
    kind === 'webhook'
      ? fillPush(fields.body ?? '', samples)
      : [
          renderPush(fields.title ?? '', samples),
          renderPush(fields.body ?? '', samples),
          ...(kind === 'dingtalk' && fields.format === 'actionCard'
            ? [`［${fields.button || '打开'}］→ ${fillPush(fields.buttonUrl ?? '', samples)}`]
            : []),
        ]
          .filter(Boolean)
          .join('\n');
  return (
    <DialogForm
      title={channel ? `编辑 ${channel.name}` : '添加推送渠道'}
      busy={busy}
      error={error}
      close={close}
      submit={() => void submit()}
    >
      {!channel && (
        <label>
          类型
          <select
            value={kind}
            onChange={({ target }) => {
              const next = target.value as PushChannelKind;
              setKind(next);
              setFields(pushDefaults(next));
            }}
          >
            {Object.entries(kinds).map(([value, { name }]) => (
              <option key={value} value={value}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        名称
        <input
          value={name}
          maxLength={40}
          placeholder={kinds[kind].name}
          onChange={({ target }) => setName(target.value)}
        />
      </label>
      {kinds[kind].fields.map(({ key, label, placeholder, optional }) => (
        <label key={`${kind}-${key}`}>
          {optional ? `${label}（可选）` : label}
          <input
            value={fields[key] ?? ''}
            placeholder={has(key) ? '已设置，留空不修改' : placeholder}
            autoComplete="off"
            onChange={({ target }) => {
              set(key, target.value);
              // Written anew after it was taken away: what is written is what is kept.
              setCleared((current) => current.filter((item) => item !== key));
            }}
          />
          {optional && has(key) && (
            <button
              type="button"
              className="button"
              onClick={() => setCleared((current) => [...current, key])}
            >
              清除{label}
            </button>
          )}
        </label>
      ))}
      {kind === 'pushplus' && (
        <label>
          发送渠道
          <select
            value={fields.channel ?? ''}
            onChange={({ target }) => set('channel', target.value)}
          >
            <option value="">微信公众号（默认）</option>
            <option value="cp">企业微信应用</option>
            <option value="mail">邮件</option>
            <option value="extension">浏览器插件</option>
            <option value="app">PushPlus App</option>
          </select>
        </label>
      )}
      {pushFormats[kind].length > 0 && (
        <label>
          消息格式
          <select value={fields.format} onChange={({ target }) => format(target.value)}>
            {pushFormats[kind].map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind !== 'webhook' && (
        <label>
          标题
          <input
            value={fields.title ?? ''}
            maxLength={200}
            onChange={({ target }) => set('title', target.value)}
          />
        </label>
      )}
      <label>
        {kind === 'webhook' ? '请求体（JSON，留空则对地址发 GET）' : '正文'}
        <textarea
          rows={6}
          value={fields.body ?? ''}
          onChange={({ target }) => set('body', target.value)}
        />
      </label>
      {kind === 'dingtalk' && fields.format === 'actionCard' && (
        <>
          <label>
            按钮文字
            <input
              value={fields.button ?? ''}
              maxLength={40}
              onChange={({ target }) => set('button', target.value)}
            />
          </label>
          <label>
            按钮地址
            <input
              value={fields.buttonUrl ?? ''}
              onChange={({ target }) => set('buttonUrl', target.value)}
            />
          </label>
        </>
      )}
      {kind === 'bark' && (
        <label>
          点击后打开
          <input
            value={fields.clickUrl ?? ''}
            onChange={({ target }) => set('clickUrl', target.value)}
          />
        </label>
      )}
      <details className="push-variables">
        <summary>可用的变量</summary>
        <ul>
          {pushVariables.map(({ name, label }) => (
            <li key={name}>
              <code>{`{${name}}`}</code> {label}
            </li>
          ))}
        </ul>
        <small className="muted">
          一行里的变量都没有值时，这一行不发送。没有标题栏的格式把标题作为第一行。按钮地址里
          {' {url} '}原样使用，其他变量按网址编码。
        </small>
      </details>
      <label>
        预览（示例值）
        {page === null ? (
          <pre className="push-preview">{preview}</pre>
        ) : (
          <>
            <strong className="push-preview-title">
              {renderPush(fields.title ?? '', samples)}
            </strong>
            <iframe className="push-preview-page" title="预览" sandbox="" srcDoc={page} />
          </>
        )}
      </label>
    </DialogForm>
  );
}
