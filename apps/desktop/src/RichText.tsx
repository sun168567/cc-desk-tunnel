import Markdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useRef } from 'react';
import type { ReactNode } from 'react';
import { CopyButton } from './copy.tsx';

function CodeBlock({ children }: { children?: ReactNode }) {
  const block = useRef<HTMLPreElement>(null);
  return (
    <div className="code-block">
      <pre ref={block}>{children}</pre>
      <CopyButton text={() => block.current?.textContent ?? ''} label="复制代码" />
    </div>
  );
}

const components: Components = {
  pre: CodeBlock,
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

export default function RichText({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
      {text}
    </Markdown>
  );
}
