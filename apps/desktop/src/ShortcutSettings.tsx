import { useState } from 'react';
import { setPrefs, usePrefs } from './prefs.ts';
import { actions, comboOf, keyFor, show, usable } from './shortcuts.ts';
import type { Action } from './shortcuts.ts';
import { Switch } from './ui.tsx';

export default function ShortcutSettings() {
  const prefs = usePrefs();
  const { enabled } = prefs.shortcuts;
  // The action whose next key press becomes its shortcut.
  const [recording, setRecording] = useState<Action | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const set = (action: Action, combo: string) =>
    setPrefs((value) => ({
      ...value,
      shortcuts: { ...value.shortcuts, keys: { ...value.shortcuts.keys, [action]: combo } },
    }));
  const stop = () => {
    setRecording(null);
    setFailure(null);
  };
  const listed = actions.filter((action) => !action.desktop || window.desktop);
  return (
    <section className="page" aria-label="快捷键">
      <div className="page-body">
        <h1 className="page-title">快捷键</h1>
        <p className="muted">
          快捷键只在本窗口处于前台时起作用，不向系统注册全局热键；在内嵌的原生终端里和对话框打开时，按键原样交给它们。
        </p>
        <div className="card">
          <div className="setting-row">
            <span>
              <strong>启用快捷键</strong>
              <small>关闭后下面的组合键全部不再响应，菜单里的功能照常可用</small>
            </span>
            <Switch
              label="启用快捷键"
              checked={enabled}
              onChange={(value) => {
                stop();
                setPrefs((current) => ({
                  ...current,
                  shortcuts: { ...current.shortcuts, enabled: value },
                }));
              }}
            />
          </div>
        </div>
        <h2 className="page-heading">组合键</h2>
        <p className="muted">
          点一项后按下新的组合键（需要包含 Ctrl 或 Alt，或是功能键）；按 Esc 取消，按 Backspace
          去掉这一项的快捷键。
        </p>
        {failure && (
          <p className="error-text" role="alert">
            {failure}
          </p>
        )}
        <div className="card">
          {listed.map(({ id, name }) => {
            const combo = keyFor(prefs, id);
            return (
              <div className="setting-row" key={id}>
                <span>
                  <strong>{name}</strong>
                </span>
                <button
                  type="button"
                  className={`key-button ${recording === id ? 'recording' : ''}`}
                  aria-label={`修改快捷键：${name}`}
                  disabled={!enabled}
                  onClick={() => {
                    setFailure(null);
                    setRecording(recording === id ? null : id);
                  }}
                  onBlur={() => recording === id && stop()}
                  onKeyDown={(event) => {
                    if (recording !== id || event.key === 'Tab') return;
                    // The press is this box's alone: it must not run the shortcut it may already be.
                    event.preventDefault();
                    if (event.key === 'Escape') return stop();
                    if (event.key === 'Backspace' || event.key === 'Delete') {
                      set(id, '');
                      return stop();
                    }
                    const pressed = comboOf(event);
                    if (!pressed) return;
                    if (!usable(pressed))
                      return setFailure(`${show(pressed)} 会妨碍正常输入；请加上 Ctrl 或 Alt。`);
                    const taken = listed.find(
                      (other) => other.id !== id && keyFor(prefs, other.id) === pressed,
                    );
                    if (taken) return setFailure(`${show(pressed)} 已被“${taken.name}”使用。`);
                    set(id, pressed);
                    stop();
                  }}
                >
                  {recording === id ? '按下新的组合键…' : combo ? show(combo) : '未设置'}
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="button"
          onClick={() => {
            stop();
            setPrefs((value) => ({ ...value, shortcuts: { ...value.shortcuts, keys: {} } }));
          }}
        >
          恢复默认组合键
        </button>
      </div>
    </section>
  );
}
