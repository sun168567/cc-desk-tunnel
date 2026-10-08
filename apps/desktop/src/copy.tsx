import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

export async function copyText(text: string) {
  if (window.desktop) await window.desktop.copyText(text);
  else await navigator.clipboard.writeText(text);
}

export function CopyButton({
  text,
  label = '复制消息',
}: {
  text: string | (() => string);
  label?: string;
}) {
  const [status, setStatus] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className="copy-button"
      aria-label={status || label}
      title={status || label}
      data-search-ignore
      onClick={async () => {
        try {
          await copyText(typeof text === 'function' ? text() : text);
          setStatus('已复制');
        } catch {
          setStatus('复制失败，请重试');
        }
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setStatus(''), 2000);
      }}
    >
      {status === '已复制' ? <Check /> : <Copy />}
      <span>{status || label}</span>
    </button>
  );
}
