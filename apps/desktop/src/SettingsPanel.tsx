import { useEffect, useState } from 'react';
import { Settings2, X } from 'lucide-react';
import type { NativeSettings } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { IconButton } from './ui.tsx';

type Toggle = {
  [K in keyof NativeSettings]: NativeSettings[K] extends boolean | null ? K : never;
}[keyof NativeSettings];
const toggles: { key: Toggle; title: string; detail: string }[] = [
  {
    key: 'autoCompactEnabled',
    title: '自动压缩上下文',
    detail: '上下文接近窗口上限时自动摘要并继续',
  },
  { key: 'alwaysThinkingEnabled', title: '思考', detail: '关闭后模型不再进行扩展思考' },
  {
    key: 'fastMode',
    title: '快速模式',
    detail: '官方 fast mode：输出更快，计费与额度消耗按官方规则',
  },
  {
    key: 'autoContinueAtUsageLimit',
    title: '额度用尽后自动继续',
    detail: '订阅额度触顶时等待重置并自动接着做，适合长任务',
  },
  {
    key: 'switchModelsOnFlag',
    title: '触发安全拦截时换模型',
    detail: '消息被拦截时自动改用其他模型继续，关闭则暂停',
  },
  { key: 'autoMemoryEnabled', title: '自动记忆', detail: '允许读写自动记忆目录' },
  {
    key: 'fileCheckpointingEnabled',
    title: '文件检查点',
    detail: '编辑前保存快照，供 /rewind 恢复',
  },
];
const windows = [100_000, 200_000, 300_000, 400_000, 500_000, 750_000, 1_000_000];
const size = (tokens: number) =>
  tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${tokens / 1000}K`;

// Edits the official CLI's user settings on the cloud host. Each change is saved at once; "默认" removes the
// key so the CLI's own default applies.
export default function SettingsPanel({
  client,
  close,
}: {
  client: ProxyClient;
  close: () => void;
}) {
  const [values, setValues] = useState<NativeSettings | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [language, setLanguage] = useState('');
  useEffect(() => {
    let current = true;
    client.fetch({ type: 'settings.get' }).then(
      (reply) => {
        if (!current) return;
        setValues(reply.values);
        setLanguage(reply.values.language ?? '');
      },
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
      setLanguage(reply.values.language ?? '');
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '保存失败。');
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="account-page" aria-label="Claude Code 设置">
      <header className="account-heading">
        <h1>
          <Settings2 />
          Claude Code 设置
        </h1>
        <IconButton title="关闭设置" onClick={close}>
          <X />
        </IconButton>
      </header>
      <div className="account-body">
        <p className="muted">
          这里修改的是云端官方 CLI 的用户设置文件，从下一次运行起生效；“默认”表示不写入该项，由 CLI
          自行决定。
        </p>
        {failure && (
          <p className="error-text" role="alert">
            {failure}
          </p>
        )}
        {values && (
          <div className="settings-list">
            <label>
              <span>
                <strong>自动压缩窗口</strong>
                <small>上下文达到这个大小前后触发自动压缩；不超过模型自身的窗口</small>
              </span>
              <select
                aria-label="自动压缩窗口"
                disabled={saving}
                value={values.autoCompactWindow ?? ''}
                onChange={(event) =>
                  void save({
                    autoCompactWindow: event.target.value ? Number(event.target.value) : null,
                  })
                }
              >
                <option value="">默认（自动）</option>
                {[
                  ...new Set([
                    ...windows,
                    ...(values.autoCompactWindow ? [values.autoCompactWindow] : []),
                  ]),
                ]
                  .sort((a, b) => a - b)
                  .map((tokens) => (
                    <option key={tokens} value={tokens}>
                      {size(tokens)} tokens
                    </option>
                  ))}
              </select>
            </label>
            {toggles.map(({ key, title, detail }) => (
              <label key={key}>
                <span>
                  <strong>{title}</strong>
                  <small>{detail}</small>
                </span>
                <select
                  aria-label={title}
                  disabled={saving}
                  value={values[key] === null ? '' : String(values[key])}
                  onChange={(event) =>
                    void save({ [key]: event.target.value ? event.target.value === 'true' : null })
                  }
                >
                  <option value="">默认</option>
                  <option value="true">开启</option>
                  <option value="false">关闭</option>
                </select>
              </label>
            ))}
            <label>
              <span>
                <strong>提示缓存时长</strong>
                <small>主对话的提示缓存保留时间</small>
              </span>
              <select
                aria-label="提示缓存时长"
                disabled={saving}
                value={values.promptCacheTtl ?? ''}
                onChange={(event) =>
                  void save({
                    promptCacheTtl: (event.target.value ||
                      null) as NativeSettings['promptCacheTtl'],
                  })
                }
              >
                <option value="">默认（自动）</option>
                <option value="5m">5 分钟</option>
                <option value="1h">1 小时</option>
              </select>
            </label>
            <label>
              <span>
                <strong>回复语言</strong>
                <small>例如 chinese、japanese；留空由 CLI 决定</small>
              </span>
              <input
                aria-label="回复语言"
                disabled={saving}
                value={language}
                maxLength={60}
                spellCheck={false}
                onChange={(event) => setLanguage(event.target.value)}
                onBlur={() => {
                  if (language.trim() !== (values.language ?? ''))
                    void save({ language: language.trim() || null });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
            </label>
          </div>
        )}
      </div>
    </section>
  );
}
