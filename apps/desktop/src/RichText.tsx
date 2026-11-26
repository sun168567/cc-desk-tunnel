import Markdown, { defaultUrlTransform } from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { isValidElement, memo, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Code, Image } from 'lucide-react';
import { useT } from './i18n.ts';
import { CopyButton } from './copy.tsx';
import { isPicture, LinkPlace, linkTarget, localPicture } from './links.ts';
import { Picture } from './Picture.tsx';

// A finished drawing in a block of `svg` is shown as the picture it is, its source one click away. As an image
// it runs no script and loads nothing from elsewhere.
function drawing(children: ReactNode) {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return null;
  const { className, children: source } = children.props;
  if (!/\blanguage-svg\b/.test(className ?? '') || typeof source !== 'string') return null;
  return /<svg[\s>]/.test(source) && source.includes('</svg>') ? source : null;
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const t = useT();
  const block = useRef<HTMLPreElement>(null);
  const svg = drawing(children);
  const [shown, setShown] = useState<'picture' | 'source' | 'broken'>('picture');
  const picture = svg !== null && shown === 'picture';
  return (
    <div className="code-block">
      {picture ? (
        <img
          className="code-picture"
          alt={t('session:rich.svg')}
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
            <span>{picture ? t('session:rich.source') : t('session:rich.picture')}</span>
          </button>
        )}
        <CopyButton
          text={() => svg ?? block.current?.textContent ?? ''}
          label={t('common:copy.code')}
        />
      </span>
    </div>
  );
}

// A picture from the user's computer is shown in the conversation of a session there. Any other is a link:
// one from the web would be fetched just by being shown, and so tell its server what the reply put in its address.
function Figure({ src, alt }: { src: string; alt: string }) {
  const t = useT();
  const target = linkTarget(src, useContext(LinkPlace));
  const [broken, setBroken] = useState(false);
  if (target?.kind === 'path' && isPicture(target.path) && !broken)
    return (
      <Picture
        src={localPicture(target.path)}
        alt={alt}
        link={src}
        onError={() => setBroken(true)}
      />
    );
  return (
    <a className="picture-link" href={src} data-link={src || undefined}>
      <Image />
      {alt || t('session:picture.title')}
    </a>
  );
}

// A link keeps the address it was written with, a path on the user's computer too; the conversation follows it
// (see links.ts), as the window itself opens nothing. Addresses of other kinds are dropped.
const urlTransform = (url: string) =>
  /^(?:[a-z]:(?:[\\/]|%5c)|file:)/i.test(url) ? url : defaultUrlTransform(url);
function decoded(text: string) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// A path this window cannot open still reads as a link, a quieter one; its menu can copy it. Where a link leads is
// shown beside it by the conversation; outside one, as the browser's own tip.
function Anchor({ href, children }: { href?: string; children?: ReactNode }) {
  const place = useContext(LinkPlace);
  const elsewhere = href && linkTarget(href, place)?.kind === 'elsewhere';
  return (
    <a
      href={href}
      className={elsewhere ? 'link-elsewhere' : undefined}
      data-link={href || undefined}
      title={place ? undefined : href && decoded(href)}
    >
      {children}
    </a>
  );
}

const components: Components = {
  pre: CodeBlock,
  a: ({ href, children }) => <Anchor href={href}>{children}</Anchor>,
  img: ({ src, alt }) => <Figure src={typeof src === 'string' ? src : ''} alt={alt ?? ''} />,
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
      {dollars(text)}
    </Markdown>
  );
});
