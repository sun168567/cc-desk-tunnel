import Markdown, { defaultUrlTransform } from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { isValidElement, lazy, memo, Suspense, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Code, Image } from 'lucide-react';
import { FileMention } from './AttachmentCards.tsx';
import { highlightSource, languageFromCodeBlock } from './code-highlight.ts';
import { CopyButton } from './copy.tsx';
import { linkFilePaths, pathFromMention } from './file-mentions.ts';

const MermaidDiagram = lazy(() => import('./MermaidDiagram.tsx'));

const mermaidHeader =
  /^\s*(?:%%\{[\s\S]*?\}%%\s*)*(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b|^\s*(?:%%\{[\s\S]*?\}%%\s*)*(?:sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|mindmap|timeline|gitGraph|journey|quadrantChart|C4Context)\b/m;

function extractCodeChild(children: ReactNode): { className?: string; source: string } | null {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return null;
  const { className, children: raw } = children.props;
  const source = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join('') : '';
  if (!source) return null;
  return { className, source };
}

// A finished drawing in a block of `svg` is shown as the picture it is, its source one click away. As an image
// it runs no script and loads nothing from elsewhere.
function drawing(info: { className?: string; source: string } | null) {
  if (!info) return null;
  const { className, source } = info;
  const trimmed = source.trim();
  if (
    (/\blanguage-(?:svg|xml|html)\b/.test(className ?? '') || !className) &&
    /^<svg[\s>]/i.test(trimmed) &&
    /<\/svg>\s*$/i.test(trimmed)
  ) {
    return trimmed;
  }
  return null;
}

function mermaidCode(info: { className?: string; source: string } | null) {
  if (!info) return null;
  const { className, source } = info;
  if (/\blanguage-(?:mermaid|mmd)\b/i.test(className ?? '')) return source;
  if (!className && mermaidHeader.test(source)) return source;
  return null;
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const block = useRef<HTMLPreElement>(null);
  const info = extractCodeChild(children);
  const svg = drawing(info);
  const mermaid = svg ? null : mermaidCode(info);
  const [shown, setShown] = useState<'picture' | 'source' | 'broken'>('picture');
  const hasDiagram = svg !== null || mermaid !== null;
  const picture = hasDiagram && shown === 'picture';
  const rawSource = info?.source ?? '';
  const cleanSource = rawSource.replace(/\n$/, '');
  const singleLine = !hasDiagram && !cleanSource.includes('\n');
  const language = info ? languageFromCodeBlock(info.className, cleanSource) : null;
  const highlighted = !picture && cleanSource ? highlightSource(cleanSource, language) : null;

  return (
    <div className={`code-block${singleLine ? ' code-block-single' : ''}`}>
      {picture && svg !== null ? (
        <img
          className="code-picture"
          alt="SVG 图像"
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
          onError={() => setShown('broken')}
        />
      ) : picture && mermaid !== null ? (
        <Suspense
          fallback={
            <pre ref={block}>
              <code>{cleanSource}</code>
            </pre>
          }
        >
          <MermaidDiagram source={mermaid} onBroken={() => setShown('broken')} />
        </Suspense>
      ) : highlighted ? (
        <pre ref={block}>
          <code
            className={info?.className}
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        </pre>
      ) : (
        <pre ref={block}>{children}</pre>
      )}
      <span className="code-actions" data-search-ignore>
        {hasDiagram && shown !== 'broken' && (
          <button
            type="button"
            className="copy-button"
            onClick={() => setShown(picture ? 'source' : 'picture')}
          >
            {picture ? <Code /> : <Image />}
            <span>{picture ? '查看源码' : '查看图像'}</span>
          </button>
        )}
        <CopyButton
          text={() => svg ?? mermaid ?? (cleanSource || (block.current?.textContent ?? ''))}
          label="复制代码"
        />
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
