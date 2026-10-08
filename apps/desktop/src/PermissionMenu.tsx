import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, FilePen, Hand, ListChecks, ShieldCheck } from 'lucide-react';
import type { PermissionMode } from '@cc-desk-tunnel/protocol';

// The four modes are Claude Code's own; the lines under them say what each asks the user for.
const modes: { value: PermissionMode; name: string; detail: string; icon: typeof Hand }[] = [
  {
    value: 'auto',
    name: '自动审批',
    detail: '由 Claude Code 判断风险，只在必要时询问',
    icon: ShieldCheck,
  },
  { value: 'default', name: '手动审批', detail: '编辑文件和执行命令前都先询问', icon: Hand },
  {
    value: 'acceptEdits',
    name: '接受编辑',
    detail: '文件编辑直接通过，执行命令仍先询问',
    icon: FilePen,
  },
  { value: 'plan', name: '计划模式', detail: '只调研并给出计划，不做改动', icon: ListChecks },
];

export default function PermissionMenu({
  mode,
  disabled,
  change,
}: {
  mode: PermissionMode;
  disabled: boolean;
  change: (mode: PermissionMode) => void;
}) {
  const [open, setOpen] = useState(false);
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
    };
  }, [open]);
  const current = modes.find((item) => item.value === mode)!;
  return (
    <div className="permission-control" ref={container}>
      <button
        type="button"
        className="chip"
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
      {open && (
        <div className="permission-menu" role="menu" aria-label="审批模式">
          <p className="menu-heading">Claude Code 操作前如何征求同意？</p>
          {modes.map(({ value, name, detail, icon: Icon }) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={value === mode}
              aria-label={name}
              key={value}
              onClick={() => {
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
