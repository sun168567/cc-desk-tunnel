import Markdown, { defaultUrlTransform } from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { isValidElement, memo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Code, Image } from 'lucide-react';
import { FileMention } from './AttachmentCards.tsx';
import { CopyButton } from './copy.tsx';
import { linkFilePaths, pathFromMention } from './file-mentions.ts';

// A finished drawing in a block of `svg` is shown as the picture it is, its source one click away. As an image
// it runs no script and loads nothing from elsewhere.
function drawing(children: ReactNode) {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return null;
  const { className, children: source } = children.props;
  if (!/\blanguage-svg\b/.test(className ?? '') || typeof source !== 'string') return null;
  return /<svg[\s>]/.test(source) && source.includes('</svg>') ? source : null;
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const block = useRef<HTMLPreElement>(null);
  const svg = drawing(children);
  const [shown, setShown] = useState<'picture' | 'source' | 'broken'>('picture');
  const picture = svg !== null && shown === 'picture';
  return (
    <div className="code-block">
      {picture ? (
        <img
          className="code-picture"
          alt="SVG 图像"
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
          onError={() => setShown('broken')}
        />
      ) : (
        <pre ref={block}>{children}</pre>
      )}
      <span className="code-actions" data-search-ignore>
        {svg !== null && shown !== 'broken' && (
          <button
            type="button"
            className="copy-button"
            onClick={() => setShown(picture ? 'source' : 'picture')}
          >
            {picture ? <Code /> : <Image />}
            <span>{picture ? '查看源码' : '查看图像'}</span>
          </button>
        )}
        <CopyButton text={() => svg ?? block.current?.textContent ?? ''} label="复制代码" />
      </span>
    </div>
  );
}

const components: Components = {
  pre: CodeBlock,
  a: ({ children, href, ...props }) => {
    const path = pathFromMention(href);
    if (path) return <FileMention path={path} />;
    return (
      <a {...props} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};

// Formulas are also written as \( … \) and \[ … \], which Markdown would read as escaped brackets; outside of
// code they become the dollar form the parser knows.
const fence = '^ {0,3}(?:`{3,}|~{3,})';
const code = new RegExp(
  `(${fence}[\\s\\S]*?(?:${fence}[^\\S\\n]*$|(?![\\s\\S]))|\`[^\`\\n]*\`)`,
  'm',
);
// A dollar sign is far more often a price than a formula. One opens a formula only as it does in Pandoc:
// closed on the same line, no space just inside either end, and no digit right after the closing one. Any
// other is escaped, so that "$5 and $8" stays text.
function prices(prose: string) {
  let result = '';
  for (let at = 0; at < prose.length;) {
    const character = prose[at];
    if (character === '\\') {
      result += prose.slice(at, at + 2);
      at += 2;
    } else if (character !== '$') {
      result += character;
      at++;
    } else if (prose[at + 1] === '$') {
      const end = prose.indexOf('$$', at + 2);
      const next = end < 0 ? prose.length : end + 2;
      result += prose.slice(at, next);
      at = next;
    } else {
      let close = at + 1;
      while (close < prose.length && prose[close] !== '$' && prose[close] !== '\n')
        close += prose[close] === '\\' ? 2 : 1;
      const body = prose.slice(at + 1, close);
      if (prose[close] !== '$') {
        result += character;
        at++;
      } else if (body && !/^\s|\s$/.test(body) && !/\d/.test(prose[close + 1] ?? '')) {
        result += prose.slice(at, close + 1);
        at = close + 1;
      } else {
        result += '\\$';
        at++;
      }
    }
  }
  return result;
}
export function dollars(text: string) {
  if (!text.includes('$') && !text.includes('\\(') && !text.includes('\\[')) return text;
  return text
    .split(code)
    .map((part, index) =>
      // Prose and code alternate, prose first.
      index % 2
        ? part
        : prices(part)
            .replace(/\\\[([\s\S]+?)\\\]/g, (_, formula: string) => `$$${formula}$$`)
            .replace(/\\\(([^\n]+?)\\\)/g, (_, formula: string) => `$${formula}$`),
    )
    .join('');
}

const remarkPlugins = [remarkGfm, remarkMath];
function urlTransform(url: string) {
  return url.startsWith('cc-file:') ? url : defaultUrlTransform(url);
}
const rehypePlugins: [typeof rehypeKatex, { strict: boolean }][] = [
  [rehypeKatex, { strict: false }],
];

export default memo(function RichText({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      skipHtml
      urlTransform={urlTransform}
      components={components}
    >
      {linkFilePaths(dollars(text))}
    </Markdown>
  );
});
