import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  FilePen,
  Hand,
  ListChecks,
  ShieldCheck,
  ShieldOff,
} from 'lucide-react';
import type { PermissionMode } from '@cc-desk-tunnel/protocol';
import { usePrefs } from './prefs.ts';

// Claude keeps its own five meanings. Codex uses the same menu, but each line is what that
// session will actually send: Codex has no stricter "ask every time" policy than on-request.
type Mode = { value: PermissionMode; name: string; detail: string; icon: typeof Hand };
const modes = (who: string): Mode[] => {
  const codex = who !== 'Claude Code';
  return [
    {
      value: 'auto',
      name: '自动审批',
      detail: codex
        ? '需要确认时询问。工作区可写，可经 SSH 访问你的电脑'
        : '由 Claude Code 判断风险，只在必要时询问',
      icon: ShieldCheck,
    },
    {
      value: 'default',
      name: '手动审批',
      detail: codex ? '与自动审批相同：需要确认时询问' : '编辑文件和执行命令前都先询问',
      icon: Hand,
    },
    {
      value: 'acceptEdits',
      name: '接受编辑',
      detail: '文件编辑直接通过，执行命令仍先询问',
      icon: FilePen,
    },
    {
      value: 'plan',
      name: '计划模式',
      detail: codex ? '服务器上只读；命令和文件修改会被拒绝' : '只调研并给出计划，不做改动',
      icon: ListChecks,
    },
  ];
};
function bypassMode(who: string): Mode {
  return {
    value: 'bypassPermissions',
    name: '绕过权限',
    detail: who === 'Claude Code' ? '任何操作都不再询问，风险自负' : '不再询问，并关掉沙箱',
    icon: ShieldOff,
  };
}

export default function PermissionMenu({
  mode,
  disabled,
  who = 'Claude Code',
  change,
}: {
  mode: PermissionMode;
  disabled: boolean;
  who?: string;
  change: (mode: PermissionMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const allowed = usePrefs().bypassPermissions;
  const choices = modes(who);
  const bypass = bypassMode(who);
  // A session already in that mode shows it, whatever the setting says now.
  const offered = allowed || mode === bypass.value ? [...choices, bypass] : choices;
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
      setConfirming(false);
    };
  }, [open]);
  const current = offered.find((item) => item.value === mode) ?? choices[0];
  return (
    <div className="permission-control" ref={container}>
      <button
        type="button"
        className={mode === bypass.value ? 'chip danger' : 'chip'}
        aria-label="审批模式"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <current.icon />
        <span>{current.name}</span>
        <ChevronDown />
      </button>
      {open && confirming && (
        <div className="permission-menu" role="alertdialog" aria-label="确认绕过权限">
          <p className="menu-heading">确认绕过权限？</p>
          <p className="permission-confirm">
            这个会话里 {who}{' '}
            做任何事都不再征求同意，包括删除文件和执行命令，直到你换回别的审批模式。只在你能承担后果的环境里使用。
          </p>
          <div className="permission-confirm-actions">
            <button type="button" onClick={() => setConfirming(false)}>
              取消
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                setOpen(false);
                change(bypass.value);
              }}
            >
              绕过权限
            </button>
          </div>
        </div>
      )}
      {open && !confirming && (
        <div className="permission-menu" role="menu" aria-label="审批模式">
          <p className="menu-heading">{who} 操作前如何征求同意？</p>
          {offered.map(({ value, name, detail, icon: Icon }) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={value === mode}
              aria-label={name}
              className={value === bypass.value ? 'danger' : undefined}
              key={value}
              onClick={() => {
                if (value === bypass.value && value !== mode) return setConfirming(true);
                setOpen(false);
                if (value !== mode) change(value);
              }}
            >
              <Icon />
              <span className="menu-label">
                {name}
                <small>{detail}</small>
              </span>
              {value === mode && <Check className="menu-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
