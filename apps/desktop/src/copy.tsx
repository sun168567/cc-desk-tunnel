import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useT } from './i18n.ts';

export async function copyText(text: string) {
  if (window.desktop) await window.desktop.copyText(text);
  else await navigator.clipboard.writeText(text);
}

export function CopyButton({ text, label }: { text: string | (() => string); label?: string }) {
  const t = useT();
  // What came of the last copy, shown for a moment in place of the label.
  const [status, setStatus] = useState<'' | 'done' | 'failed'>('');
  const shown = status ? t(`common:copy.${status}`) : (label ?? t('common:copy.message'));
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className="copy-button"
      aria-label={shown}
      title={shown}
      data-search-ignore
      onClick={async () => {
        try {
          await copyText(typeof text === 'function' ? text() : text);
          setStatus('done');
        } catch {
          setStatus('failed');
        }
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setStatus(''), 2000);
      }}
    >
      {status === 'done' ? <Check /> : <Copy />}
      <span>{shown}</span>
    </button>
  );
}
