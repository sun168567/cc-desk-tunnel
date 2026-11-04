import { useEffect, useState } from 'react';
import { INSTRUCTIONS_LIMIT } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { Page } from './ui.tsx';

// The instructions every session on this service starts with: the user CLAUDE.md of the official CLI on the cloud
// host. A save goes through only over the version that was read, so a change made meanwhile in the terminal is not
// lost; the text being edited stays for the user to compare after reloading.
export default function GlobalInstructions({ client }: { client: ProxyClient }) {
  const [saved, setSaved] = useState<{ text: string; version: string } | null>(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  async function load() {
    setFailure(null);
    setStatus('');
    try {
      const { text, version } = await client.fetch({ type: 'instructions.get' });
      setSaved({ text, version });
      setText(text);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '读取失败。');
    }
  }
  useEffect(() => {
    void load();
  }, [client]);
  async function save() {
    if (!saved) return;
    setFailure(null);
    setStatus('');
    setSaving(true);
    try {
      const reply = await client.fetch({
        type: 'instructions.update',
        text,
        version: saved.version,
      });
      setSaved({ text: reply.text, version: reply.version });
      setText(reply.text);
      setStatus('已保存，从下一次运行起生效');
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '保存失败。');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Page
      title="全局说明"
      intro="云端 Claude Code 的用户级 CLAUDE.md：这个服务上的每个会话开始时都会读取，从下一次运行起生效。Claude Code 在用户级只读 CLAUDE.md，AGENTS.md 只在项目里读取；项目在你的电脑上，其中的 CLAUDE.md 与 AGENTS.md 不会自动读取，需要时在消息里请 Claude 去读。"
    >
      <div className="card instructions-card">
        <textarea
          aria-label="全局说明"
          className="instructions-editor"
          value={text}
          disabled={!saved || saving}
          maxLength={INSTRUCTIONS_LIMIT}
          spellCheck={false}
          rows={12}
          placeholder="例如：回复用中文；提交信息用中文。"
          onChange={(event) => {
            setText(event.target.value);
            setStatus('');
          }}
        />
        {failure && (
          <p className="error-text" role="alert">
            {failure}
          </p>
        )}
        <div className="setting-actions">
          <span className="muted" role="status">
            {status}
          </span>
          <button type="button" className="button" disabled={saving} onClick={() => void load()}>
            重新载入
          </button>
          <button
            type="button"
            className="button primary"
            disabled={!saved || saving || text === saved.text}
            onClick={() => void save()}
          >
            保存
          </button>
        </div>
      </div>
    </Page>
  );
}
