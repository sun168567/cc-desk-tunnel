import { Fragment, useEffect, useLayoutEffect, useRef } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { Check, X } from 'lucide-react';

export function IconButton({
  title,
  onClick,
  children,
  disabled = false,
  className = '',
}: {
  title: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      className={`icon-button ${className}`}
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function Switch({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <IconButton title="关闭" onClick={onClose}>
          <X />
        </IconButton>
      </div>
      {children}
    </dialog>
  );
}

export type MenuItem = {
  label: string;
  icon?: ReactNode;
  // A line under the label saying what the choice does.
  detail?: string;
  // Shown at the right edge: a keyboard shortcut or a current value.
  hint?: string;
  // Present on a choice among alternatives; the chosen one carries the mark.
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  // A rule is drawn above this item.
  separated?: boolean;
  run: () => void;
};
export type MenuPosition = { x: number; y: number; above?: boolean };
// One menu serves right-click (opens at the pointer) and every button that opens a list beside itself.
export function Menu({
  label,
  x,
  y,
  above = false,
  heading,
  items,
  onClose,
}: MenuPosition & {
  label: string;
  heading?: string;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current!;
    const { width, height } = menu.getBoundingClientRect();
    const top = above || y + height > innerHeight - 8 ? y - height : y;
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, top)}px`;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [x, y, above]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  return (
    <div
      className="menu"
      role="menu"
      aria-label={label}
      ref={ref}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          onClose();
          return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const buttons = [
          ...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
        ];
        const next =
          buttons.indexOf(document.activeElement as HTMLButtonElement) +
          (event.key === 'ArrowDown' ? 1 : -1);
        buttons[(next + buttons.length) % buttons.length]?.focus();
      }}
    >
      {heading && <p className="menu-heading">{heading}</p>}
      {items.map((item) => (
        <Fragment key={item.label}>
          {item.separated && <hr />}
          <button
            type="button"
            role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={item.checked}
            aria-label={item.label}
            className={`${item.danger ? 'danger' : ''} ${item.detail ? 'detailed' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            {item.icon}
            <span className="menu-label">
              {item.label}
              {item.detail && <small>{item.detail}</small>}
            </span>
            {item.hint && <kbd>{item.hint}</kbd>}
            {item.checked && <Check className="menu-check" />}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
