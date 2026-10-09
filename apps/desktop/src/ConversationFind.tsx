import { createContext, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { matchingRanges } from './conversationSearch.ts';
import { IconButton } from './ui.tsx';

export const SearchExpanded = createContext(false);

export default function ConversationFind({
  root,
  scroll,
  query,
  change,
  close,
  request,
  partial,
}: {
  root: RefObject<HTMLDivElement | null>;
  scroll: RefObject<HTMLDivElement | null>;
  query: string;
  change: (query: string) => void;
  close: () => void;
  request: number;
  // Earlier pages of the session are not loaded, and so not searched.
  partial: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const ranges = useRef<Range[]>([]);
  const active = useRef(0);
  const [result, setResult] = useState({ index: 0, count: 0 });
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [request]);
  const move = (step: number, scrollTo = true) => {
    const all = ranges.current;
    active.current = all.length ? (active.current + step + all.length) % all.length : 0;
    const range = all[active.current];
    CSS.highlights.set('conversation-current', new Highlight(...(range ? [range] : [])));
    setResult({ index: range ? active.current + 1 : 0, count: all.length });
    if (range && scrollTo && scroll.current) {
      const rect = range.getBoundingClientRect();
      const box = scroll.current.getBoundingClientRect();
      scroll.current.scrollTop += rect.top - box.top - box.height / 2;
      const horizontal = range.startContainer.parentElement?.closest('pre, table');
      if (horizontal && horizontal.scrollWidth > horizontal.clientWidth) {
        const bounds = horizontal.getBoundingClientRect();
        if (rect.left < bounds.left) horizontal.scrollLeft += rect.left - bounds.left - 12;
        else if (rect.right > bounds.right) horizontal.scrollLeft += rect.right - bounds.right + 12;
      }
    }
  };
  useEffect(() => {
    const content = root.current;
    if (!content) return;
    active.current = 0;
    let frame = 0;
    let navigate = true;
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const previous = ranges.current[active.current];
        ranges.current = matchingRanges(content, query);
        const retained = ranges.current.findIndex(
          (range) =>
            previous &&
            range.startContainer === previous.startContainer &&
            range.startOffset === previous.startOffset,
        );
        if (!navigate && retained >= 0) active.current = retained;
        active.current = Math.min(active.current, Math.max(0, ranges.current.length - 1));
        const highlights = new Highlight();
        for (const range of ranges.current) highlights.add(range);
        CSS.highlights.set('conversation-matches', highlights);
        move(0, navigate);
        if (ranges.current.length) navigate = false;
      });
    };
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(content, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      CSS.highlights.delete('conversation-matches');
      CSS.highlights.delete('conversation-current');
    };
  }, [query, root]);
  return (
    <div
      className="conversation-find"
      role="search"
      aria-label="对话内查找"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
        if (event.key === 'Enter' && event.target === input.current) {
          event.preventDefault();
          move(event.shiftKey ? -1 : 1);
        }
      }}
    >
      <input
        ref={input}
        aria-label="查找对话内容"
        value={query}
        placeholder="查找对话内容"
        onChange={(event) => change(event.target.value)}
      />
      <span className="find-count" role="status">
        {result.index} / {result.count}
        {partial ? '（仅已加载部分）' : ''}
      </span>
      <IconButton
        title="上一个匹配（Shift+Enter）"
        disabled={!result.count}
        onClick={() => move(-1)}
      >
        <ArrowUp />
      </IconButton>
      <IconButton title="下一个匹配（Enter）" disabled={!result.count} onClick={() => move(1)}>
        <ArrowDown />
      </IconButton>
      <IconButton title="关闭查找（Esc）" onClick={close}>
        <X />
      </IconButton>
    </div>
  );
}
