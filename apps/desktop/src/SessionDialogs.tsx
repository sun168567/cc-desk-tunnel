import { useState } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import type { Session } from '@cc-desk-tunnel/protocol';
import { folderName } from './paths.ts';
import { Modal } from './ui.tsx';

// The dialogs share the window's busy flag and error line, so a failed request stays visible in the open dialog.
type DialogProps = { busy: boolean; connected: boolean; error: string | null; close: () => void };

export function AddProjectDialog({
  busy,
  connected,
  error,
  close,
  add,
}: DialogProps & { add: (path: string) => void }) {
  const [path, setPath] = useState('');
  return (
    <Modal
      title="添加项目"
      onClose={() => {
        if (!busy) close();
      }}
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          add(path.trim());
        }}
      >
        <label>
          Windows 项目目录
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="D:\projects\my-project"
            maxLength={2048}
            required
            spellCheck={false}
          />
        </label>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button className="button primary" disabled={busy || !connected}>
            <Plus />
            添加
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function DeleteSessionDialog({
  session,
  native,
  busy,
  connected,
  error,
  close,
  confirm,
}: DialogProps & {
  session: Session;
  native: boolean;
  confirm: () => void;
}) {
  return (
    <Modal
      title="删除会话"
      onClose={() => {
        if (!busy) close();
      }}
    >
      <p className="delete-question">删除“{session.title}”？</p>
      <p className="muted">
        {native
          ? '原生 Claude Code 会话及代理展示记录将删除，Windows 项目文件保持不变。'
          : '会话记录将被删除，项目文件保持不变。'}
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={close}>
          取消
        </button>
        <button
          type="button"
          className="button danger"
          disabled={busy || !connected}
          onClick={confirm}
        >
          <Trash2 />
          删除
        </button>
      </div>
    </Modal>
  );
}

export function RenameSessionDialog({
  session,
  busy,
  connected,
  error,
  close,
  rename,
}: DialogProps & {
  session: Session;
  rename: (title: string) => void;
}) {
  const [title, setTitle] = useState(session.title);
  return (
    <Modal
      title="重命名会话"
      onClose={() => {
        if (!busy) close();
      }}
    >
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          rename(title);
        }}
      >
        <label>
          名称
          <input
            autoFocus
            maxLength={120}
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button className="button primary" disabled={busy || !connected}>
            <Check />
            保存
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function RenameProjectDialog({
  path,
  name: current,
  close,
  rename,
}: {
  path: string;
  name: string;
  close: () => void;
  rename: (name: string) => void;
}) {
  const [name, setName] = useState(current);
  return (
    <Modal title="项目显示名称" onClose={close}>
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          rename(name.trim());
        }}
      >
        <label>
          显示名称
          <input
            autoFocus
            maxLength={60}
            value={name}
            placeholder={folderName(path)}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <p className="muted">
          只改变这台电脑上列表里的名字，不改动文件夹 <code>{path}</code>；留空恢复文件夹名。
        </p>
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={close}>
            取消
          </button>
          <button className="button primary">
            <Check />
            保存
          </button>
        </div>
      </form>
    </Modal>
  );
}
