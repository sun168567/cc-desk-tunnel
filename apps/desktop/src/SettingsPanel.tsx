import { useEffect, useState } from 'react';
import type { NativeSettings } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';

type Key = keyof NativeSettings;
type Value = NativeSettings[Key];
// A setting is a switch (default / on / off), one of a few choices, or a line of text. Choices and text say
// how their value is written in the box and read back; an empty box is "unset".
type Field = { key: Key; title: string; detail: string } & (
  | { kind: 'toggle' }
  | { kind: 'choice'; unset: string; options: [string, string][]; read: (text: string) => Value }
  | {
      kind: 'text';
      placeholder: string;
      write: (value: Value) => string;
      read: (text: string) => Value;
    }
);
const sizes = (values: number[], current: unknown, name: (value: number) => string) =>
  [...new Set([...values, ...(typeof current === 'number' ? [current] : [])])]
    .sort((a, b) => a - b)
    .map((value): [string, string] => [String(value), name(value)]);
const tokens = (value: number) =>
  `${value >= 1_000_000 ? `${value / 1_000_000}M` : `${value / 1000}K`} tokens`;
const ttl: [string, string][] = [
  ['5m', '5 分钟'],
  ['1h', '1 小时'],
];

// The settings in the order they are shown, under the heading they belong to.
const groups = (values: NativeSettings): { name: string; fields: Field[] }[] => [
  {
    name: '上下文与记忆',
    fields: [
      {
        key: 'autoCompactEnabled',
        kind: 'toggle',
        title: '自动压缩上下文',
        detail: '上下文接近窗口上限时自动摘要并继续',
      },
      {
        key: 'autoCompactWindow',
        kind: 'choice',
        title: '自动压缩窗口',
        detail: '上下文达到这个大小前后触发自动压缩；不超过模型自身的窗口',
        unset: '默认（自动）',
        options: sizes(
          [100_000, 200_000, 300_000, 400_000, 500_000, 750_000, 1_000_000],
          values.autoCompactWindow,
          tokens,
        ),
        read: Number,
      },
      {
        key: 'precomputeCompactionEnabled',
        kind: 'toggle',
        title: '提前准备压缩摘要',
        detail: '在需要之前于后台算好摘要，压缩时少等；仅在自动压缩开启时有效',
      },
      {
        key: 'autoMemoryEnabled',
        kind: 'toggle',
        title: '自动记忆',
        detail: '允许读写自动记忆目录',
      },
      {
        key: 'autoDreamEnabled',
        kind: 'toggle',
        title: '后台整理记忆',
        detail: '空闲时在后台归并、整理已有的记忆',
      },
      {
        key: 'fileCheckpointingEnabled',
        kind: 'toggle',
        title: '文件检查点',
        detail: '编辑前保存快照，供 /rewind 恢复',
      },
    ],
  },
  {
    name: '模型与额度',
    fields: [
      {
        key: 'alwaysThinkingEnabled',
        kind: 'toggle',
        title: '思考',
        detail: '关闭后模型不再进行扩展思考',
      },
      {
        key: 'fastMode',
        kind: 'toggle',
        title: '快速模式',
        detail: '官方 fast mode：输出更快，计费与额度消耗按官方规则',
      },
      {
        key: 'fallbackModel',
        kind: 'text',
        title: '备用模型',
        detail: '主模型过载或不可用时依次改用；填模型名或别名，逗号分隔，最多 5 个',
        placeholder: '例如 sonnet, haiku',
        write: (value) => (Array.isArray(value) ? value.join(', ') : ''),
        read: (text) => {
          const names = text.split(/[,，\s]+/).filter(Boolean);
          return names.length ? names.slice(0, 5) : null;
        },
      },
      {
        key: 'autoContinueAtUsageLimit',
        kind: 'toggle',
        title: '额度用尽后自动继续',
        detail: '订阅额度触顶时等待重置并自动接着做，适合长任务',
      },
      {
        key: 'switchModelsOnFlag',
        kind: 'toggle',
        title: '触发安全拦截时换模型',
        detail: '消息被拦截时自动改用其他模型继续，关闭则暂停',
      },
      {
        key: 'promptCacheTtl',
        kind: 'choice',
        title: '提示缓存时长',
        detail: '主对话的提示缓存保留时间',
        unset: '默认（自动）',
        options: ttl,
        read: (text) => text as Value,
      },
      {
        key: 'subagentPromptCacheTtl',
        kind: 'choice',
        title: '子任务的提示缓存时长',
        detail: '主对话之外的请求：子代理、后台与辅助请求',
        unset: '默认（自动）',
        options: ttl,
        read: (text) => text as Value,
      },
    ],
  },
  {
    name: '行为',
    fields: [
      {
        key: 'language',
        kind: 'text',
        title: '回复语言',
        detail: '例如 chinese、japanese；留空由 CLI 决定',
        placeholder: '',
        write: (value) => (typeof value === 'string' ? value : ''),
        read: (text) => text || null,
      },
      {
        key: 'askUserQuestionTimeout',
        kind: 'choice',
        title: '提问无人回答时',
        detail: 'Claude 的提问等多久后带着已选的答案自行继续；无人值守的任务不至于一直停着',
        unset: '默认（一直等）',
        options: [
          ['60s', '60 秒后继续'],
          ['5m', '5 分钟后继续'],
          ['10m', '10 分钟后继续'],
          ['never', '一直等'],
        ],
        read: (text) => text as Value,
      },
      {
        key: 'bashOutputMaxChars',
        kind: 'choice',
        title: '命令输出上限',
        detail:
          '一条命令的输出直接交给 Claude 的字符数，超出的部分存成文件只给预览；Windows 上的操作都经命令执行',
        unset: '默认（30K）',
        options: sizes(
          [10_000, 30_000, 60_000, 100_000, 128_000],
          values.bashOutputMaxChars,
          (value) => `${value / 1000}K 字符`,
        ),
        read: Number,
      },
    ],
  },
  {
    name: 'Git',
    fields: [
      {
        key: 'attribution',
        kind: 'choice',
        title: '提交与 PR 的署名',
        detail: 'Claude Code 默认在提交信息和 PR 描述里加上自己的署名',
        unset: '默认（加署名）',
        options: [['false', '不加署名']],
        read: () => false,
      },
      {
        key: 'includeGitInstructions',
        kind: 'toggle',
        title: '内置的提交与 PR 流程说明',
        detail: '系统提示词里附带的提交、开 PR 的做法；按自己的流程来时可以关闭',
      },
    ],
  },
];

// Edits the official CLI's user settings on the cloud host. Each change is saved at once; "默认" removes the
// key so the CLI's own default applies.
export default function SettingsPanel({ client }: { client: ProxyClient }) {
  const [values, setValues] = useState<NativeSettings | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Text being typed, by key; it is saved when the box is left.
  const [typed, setTyped] = useState<Partial<Record<Key, string>>>({});
  useEffect(() => {
    let current = true;
    client.fetch({ type: 'settings.get' }).then(
      (reply) => current && setValues(reply.values),
      (error: Error) => current && setFailure(error.message),
    );
    return () => {
      current = false;
    };
  }, [client]);
  async function save(change: Partial<NativeSettings>) {
    setFailure(null);
    setSaving(true);
    try {
      const reply = await client.fetch({ type: 'settings.update', values: change });
      setValues(reply.values);
      setTyped({});
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '保存失败。');
    } finally {
      setSaving(false);
    }
  }
  function control(field: Field, value: Value) {
    if (field.kind === 'text') {
      const saved = field.write(value);
      const text = typed[field.key] ?? saved;
      return (
        <input
          aria-label={field.title}
          disabled={saving}
          value={text}
          placeholder={field.placeholder}
          maxLength={200}
          spellCheck={false}
          onChange={(event) => setTyped({ ...typed, [field.key]: event.target.value })}
          onBlur={() => {
            if (field.write(field.read(text.trim())) !== saved)
              void save({ [field.key]: field.read(text.trim()) });
            else setTyped(({ [field.key]: _left, ...rest }) => rest);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      );
    }
    const options: [string, string][] =
      field.kind === 'toggle'
        ? [
            ['true', '开启'],
            ['false', '关闭'],
          ]
        : field.options;
    return (
      <select
        aria-label={field.title}
        disabled={saving}
        value={value === null ? '' : String(value)}
        onChange={({ target }) =>
          void save({
            [field.key]: !target.value
              ? null
              : field.kind === 'toggle'
                ? target.value === 'true'
                : field.read(target.value),
          })
        }
      >
        <option value="">{field.kind === 'toggle' ? '默认' : field.unset}</option>
        {options.map(([option, name]) => (
          <option key={option} value={option}>
            {name}
          </option>
        ))}
      </select>
    );
  }
  return (
    <section className="page" aria-label="Claude Code 设置">
      <div className="page-body">
        <h1 className="page-title">Claude Code</h1>
        <p className="muted">
          这里修改的是云端官方 CLI 的用户设置文件，从下一次运行起生效；“默认”表示不写入该项，由 CLI
          自行决定。
        </p>
        {failure && (
          <p className="error-text" role="alert">
            {failure}
          </p>
        )}
        {values &&
          groups(values).map((group) => (
            <div key={group.name}>
              <h2 className="page-heading">{group.name}</h2>
              <div className="settings-list card">
                {group.fields.map((field) => (
                  <label key={field.key}>
                    <span>
                      <strong>{field.title}</strong>
                      <small>{field.detail}</small>
                    </span>
                    {control(field, values[field.key])}
                  </label>
                ))}
              </div>
            </div>
          ))}
      </div>
    </section>
  );
}
