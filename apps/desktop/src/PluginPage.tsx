import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { shownWhen } from '@cc-desk-tunnel/protocol';
import type {
  Plugin,
  PluginField,
  PluginGroup,
  PluginValue,
  PluginValues,
} from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { Page, Row, SettingsHeading, SettingText, Switch } from './ui.tsx';

export const titleOf = (plugin: Plugin) => plugin.title ?? plugin.id;
// What a plugin reaches, in a word, and what that comes to for one that reaches everything.
export const reach = {
  own: '只能读写自己的文件，可以联网',
  full: '完整权限',
  unlimited: '不受限制（服务端的系统不支持限制）',
  all: '它能读到服务端上的凭据，也能在你的电脑上执行命令。',
};
// What is to be told of a plugin, and in a word; nothing of one that goes well.
export function troubleOf({ enabled, problem, failure }: Plugin) {
  if (problem) return { word: enabled ? '未运行' : '未启用', text: problem };
  if (!enabled || !failure) return undefined;
  const at = new Date(failure.at).toLocaleString('zh-CN');
  return { word: '上次失败', text: `${failure.message}（${at}）` };
}

type Done = { ok: boolean; message: string };
const eventNames: Record<string, string> = {
  ApprovalRequested: '等待审批',
  QuestionAsked: '等待回答',
  TerminalWaiting: '终端等待确认',
  WaitResolved: '等待已解除',
  BackgroundOnly: '只剩后台任务',
  RunError: '运行出错',
  RunEnded: '一轮结束',
  DeviceOnline: '设备上线',
  DeviceOffline: '设备下线',
};
const failed = (error: unknown): Done => ({
  ok: false,
  message: error instanceof Error ? error.message : '操作失败。',
});

// A plugin's settings, as it declares them: each change is saved at once, text when its box is left. One that does not
// hold is told under the field and stays there unsaved.
export default function PluginPage({
  client,
  plugin,
  enable,
  failure,
  back,
}: {
  client: ProxyClient;
  plugin: Plugin;
  enable: (enabled: boolean) => void;
  failure?: string;
  back: () => void;
}) {
  // What was changed and is not saved yet, or could not be.
  const [draft, setDraft] = useState<PluginValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string>();
  const [results, setResults] = useState<Record<string, Done | 'running'>>({});
  const { id } = plugin;
  const title = titleOf(plugin);
  const trouble = troubleOf(plugin);
  const values: PluginValues = { ...plugin.values, ...draft };

  async function act(key: string, work: () => Promise<Done>) {
    setResults((all) => ({ ...all, [key]: 'running' }));
    const done = await work().catch(failed);
    setResults((all) => ({ ...all, [key]: done }));
  }
  async function save(key: string, value: PluginValue | null) {
    if (value !== null) setDraft((all) => ({ ...all, [key]: value }));
    const without = <T,>({ [key]: _, ...rest }: Record<string, T>) => rest;
    try {
      const reply = await client.fetch({
        type: 'plugin.configure',
        id,
        values: { [key]: value },
      });
      const error = reply.errors[key];
      setNotice(reply.notice);
      setErrors((all) => (error ? { ...all, [key]: error } : without(all)));
      // Changed again meanwhile, it is the later change's to settle.
      if (!error) setDraft((all) => (all[key] === value || value === null ? without(all) : all));
    } catch (error) {
      setErrors((all) => ({ ...all, [key]: failed(error).message }));
    }
  }

  function field(key: string, item: PluginField) {
    const text = (
      <SettingText
        title={item.title}
        detail={
          errors[key] ? (
            <>
              {item.description}
              <span className="plugin-error">{errors[key]}</span>
            </>
          ) : (
            item.description
          )
        }
      />
    );
    if (item.type === 'button') {
      const done = results[key];
      return (
        <Row
          key={key}
          title={item.title}
          detail={
            done && done !== 'running' ? (
              <span className={done.ok ? 'plugin-result' : 'plugin-result bad'} role="status">
                {done.message || (done.ok ? '成功' : '失败')}
              </span>
            ) : (
              item.description
            )
          }
        >
          <button
            type="button"
            className="button"
            disabled={done === 'running'}
            onClick={() => {
              if (item.confirm && !window.confirm(item.confirm)) return;
              void act(key, () =>
                client.fetch({ type: 'plugin.press', id, button: key, values: draft }),
              );
            }}
          >
            {done === 'running' ? '正在运行…' : (item.label ?? '运行')}
          </button>
        </Row>
      );
    }
    if (item.type === 'boolean')
      return (
        <Row key={key} title={item.title} detail={item.description}>
          <Switch
            label={item.title}
            checked={!!values[key]}
            onChange={(checked) => void save(key, checked)}
          />
        </Row>
      );
    const saved = plugin.values[key] ?? '';
    const common = {
      'aria-label': item.title,
      'aria-invalid': !!errors[key],
      value: String(values[key] ?? ''),
    };
    if (item.type === 'string' && item.options) {
      const options = item.options.map((option) =>
        typeof option === 'string' ? { value: option, label: option } : option,
      );
      return (
        <label key={key}>
          {text}
          <select {...common} onChange={({ target }) => void save(key, target.value)}>
            {!options.some(({ value }) => value === common.value) && <option value="" />}
            {options.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      );
    }
    // Left as it was saved, there is nothing to save; a secret's box left empty keeps it.
    const leave = () => {
      const value = draft[key];
      if (value === undefined) return;
      if (value === saved || (item.type === 'string' && item.sensitive && value === ''))
        return void (setDraft(({ [key]: _, ...rest }) => rest),
        setErrors(({ [key]: _, ...rest }) => rest));
      if (item.type === 'number') return void save(key, value === '' ? null : Number(value));
      void save(key, value);
    };
    const typing = {
      ...common,
      onChange: ({ target }: { target: { value: string } }) =>
        setDraft((all) => ({ ...all, [key]: target.value })),
      onBlur: leave,
    };
    if (item.type === 'string' && item.multiline)
      return (
        <label key={key} className="plugin-text">
          {text}
          <textarea {...typing} rows={5} spellCheck={false} />
        </label>
      );
    const secret = item.type === 'string' && !!item.sensitive;
    const kept = secret && plugin.secrets.includes(key);
    return (
      <label key={key}>
        {text}
        <span className="plugin-input">
          <input
            {...typing}
            type={secret ? 'password' : item.type === 'number' ? 'number' : 'text'}
            {...(item.type === 'number' ? { min: item.min, max: item.max, step: 'any' } : {})}
            autoComplete="off"
            spellCheck={false}
            placeholder={kept ? '已设置，留空沿用' : undefined}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
          {kept && draft[key] === undefined && (
            <button type="button" className="button" onClick={() => void save(key, null)}>
              清除
            </button>
          )}
        </span>
      </label>
    );
  }
  function group(item: PluginGroup) {
    const whole = shownWhen(item.showWhen, values);
    const switches = [item.showWhen ?? []].flat();
    const shown = Object.entries(item.fields).filter(([key]) => whole || switches.includes(key));
    if (!shown.length) return null;
    return (
      <section key={item.title} aria-label={item.title}>
        <SettingsHeading>{item.title}</SettingsHeading>
        {item.description && <p className="muted page-section-note">{item.description}</p>}
        <div className="settings-list card plugin-fields">
          {shown.map(([key, entry]) => field(key, entry))}
        </div>
      </section>
    );
  }
  const { version, author, homepage, repository } = plugin;
  return (
    <Page
      title={title}
      intro={plugin.description}
      before={
        <button type="button" className="plugin-back" onClick={back}>
          <ChevronLeft />
          插件
        </button>
      }
    >
      <div className="settings-list card">
        <Row title="启用插件" detail="停用后不运行它的任何代码，设置保留。">
          <Switch label={`启用 ${title}`} checked={plugin.enabled} onChange={enable} />
        </Row>
      </div>
      {(failure ?? trouble) && (
        <p className="plugin-notice" role="alert">
          {failure ?? `${trouble!.word}：${trouble!.text}`}
        </p>
      )}
      {notice && (
        <p className="plugin-notice" role="alert">
          {notice}
        </p>
      )}
      {plugin.settings.map(group)}
      {plugin.enabled && plugin.events.length > 0 && (
        <>
          <SettingsHeading>试跑</SettingsHeading>
          <div className="settings-list card">
            <Try
              events={plugin.events}
              done={results.try}
              run={(event) =>
                void act('try', () => client.fetch({ type: 'plugin.try', id, event }))
              }
            />
          </div>
        </>
      )}
      <SettingsHeading>关于</SettingsHeading>
      <div className="settings-list card">
        <Row title="id">
          <span className="setting-value">{plugin.id}</span>
        </Row>
        <Row title="权限">
          <span className="setting-value">{reach[plugin.access]}</span>
        </Row>
        {version && (
          <Row title="版本">
            <span className="setting-value">{version}</span>
          </Row>
        )}
        {author && (
          <Row title="作者">
            {author.url ? (
              <Link url={author.url}>{author.name}</Link>
            ) : (
              <span className="setting-value">{author.name}</span>
            )}
          </Row>
        )}
        {homepage && (
          <Row title="主页">
            <Link url={homepage}>{homepage}</Link>
          </Row>
        )}
        {repository && (
          <Row title="发布地址">
            <Link url={repository}>{repository}</Link>
          </Row>
        )}
      </div>
    </Page>
  );
}

function Link({ url, children }: { url: string; children: string }) {
  return (
    <button
      type="button"
      className="text-link plugin-link"
      title={url}
      onClick={() =>
        window.desktop
          ? void window.desktop.openLink(url)
          : void window.open(url, '_blank', 'noopener')
      }
    >
      {children}
    </button>
  );
}

function Try({
  events,
  done,
  run,
}: {
  events: string[];
  done?: Done | 'running';
  run: (event: string) => void;
}) {
  const [chosen, setChosen] = useState(events[0]!);
  const event = events.includes(chosen) ? chosen : events[0]!;
  return (
    <>
      <Row title="用示例事件运行" detail="和事件真的来时一样运行插件的命令，它做的事会真的做。">
        <span className="plugin-try">
          <select
            aria-label="试跑的事件"
            value={event}
            onChange={({ target }) => setChosen(target.value)}
          >
            {events.map((item) => (
              <option key={item} value={item}>
                {eventNames[item] ?? item}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="button"
            disabled={done === 'running'}
            onClick={() => run(event)}
          >
            {done === 'running' ? '正在运行…' : '运行'}
          </button>
        </span>
      </Row>
      {done && done !== 'running' && (
        <pre className={done.ok ? 'plugin-result' : 'plugin-result bad'} role="status">
          {done.message}
        </pre>
      )}
    </>
  );
}
