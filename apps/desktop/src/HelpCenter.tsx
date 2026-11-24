import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  ExternalLink,
  House,
  Info,
  Lightbulb,
  MessageSquarePlus,
  Search,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import changelog from '../../../CHANGELOG.md?raw';
import { articles, freshness, groups, newsOf, starters } from './help-content.ts';
import type { Article, Block, News, Prompt, Target } from './help-content.ts';
import Figure from './HelpFigures.tsx';
import { CopyButton } from './copy.tsx';
import { releaseSection } from './notes.ts';
import { usePrefs } from './prefs.ts';
import { actions as shortcutActions, keyFor, show as keyText } from './shortcuts.ts';
import type { Action } from './shortcuts.ts';
import { openProject, project } from './project.tsx';
import './help.css';

type Context = {
  here: string;
  others: string[];
  browser: boolean;
  version: string;
  go: (article?: string) => void;
  run: (target: Target) => void;
  tryPrompt?: (text: string) => void;
};
const NEWS = 'whats-new';

// The help, a page of its own: the articles by group on the left with a search, the front page or an article on the
// right. Articles link to each other (`article#heading` goes to a heading in it), to the settings they talk about and
// to what they explain how to do. What the program's version brought is marked, and has a page of its own.
export default function HelpCenter({
  article: place,
  here,
  others,
  browser,
  version,
  go,
  run,
  tryPrompt,
}: {
  article?: string;
  here: string;
  others: string[];
  browser: boolean;
  version: string;
  go: (article?: string) => void;
  run: (target: Target) => void;
  tryPrompt?: (text: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [id, anchor] = (place ?? '').split('#');
  const shown = useMemo(() => articles.filter((item) => !browser || !item.desktop), [browser]);
  const news = useMemo(() => newsOf(version, shown), [version, shown]);
  const current = shown.find((item) => item.id === id);
  const context: Context = { here, others, browser, version, go, run, tryPrompt };
  const found = useMemo(() => search(shown, query, context), [shown, query, here, others]);
  const page = useRef<HTMLElement>(null);
  // An article opens at its top, or at the heading asked for, which is flashed to be found.
  useEffect(() => {
    const target = anchor && document.getElementById(anchorId(anchor));
    if (!target) return void page.current?.scrollTo({ top: 0 });
    target.scrollIntoView({ block: 'start' });
    target.classList.remove('help-flash');
    void target.offsetWidth;
    target.classList.add('help-flash');
  }, [place, query]);
  const open = (target?: string) => {
    setQuery('');
    go(target);
  };
  const item = (entry: Article) => {
    const fresh = freshness(entry, version);
    return (
      <button
        type="button"
        key={entry.id}
        className="side-action"
        aria-current={current?.id === entry.id && !query ? 'page' : undefined}
        onClick={() => open(entry.id)}
      >
        <entry.icon />
        <span className="help-nav-name">{entry.title}</span>
        {fresh && <Fresh kind={fresh} />}
      </button>
    );
  };
  return (
    <>
      <aside className="sidebar help-side">
        <div className="sidebar-brand">
          <span className="brand">帮助</span>
        </div>
        <label className="session-search">
          <Search />
          <input
            aria-label="搜索帮助"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && setQuery('')}
            placeholder="搜索帮助"
          />
          {query && (
            <button
              type="button"
              className="help-search-clear"
              aria-label="清除搜索"
              onClick={() => setQuery('')}
            >
              <X />
            </button>
          )}
        </label>
        <nav className="session-list help-nav" aria-label="帮助目录">
          <button
            type="button"
            className="side-action"
            aria-current={!current && id !== NEWS && !query ? 'page' : undefined}
            onClick={() => open()}
          >
            <House />
            首页
          </button>
          {news.length > 0 && (
            <button
              type="button"
              className="side-action help-nav-news"
              aria-current={id === NEWS && !query ? 'page' : undefined}
              onClick={() => open(NEWS)}
            >
              <Sparkles />
              <span className="help-nav-name">这一版新增</span>
              <span className="help-count">{news.length}</span>
            </button>
          )}
          {groups.map((group) => {
            const members = shown.filter((entry) => entry.group === group.id);
            if (!members.length) return null;
            return (
              <Fragment key={group.id}>
                <div className="list-heading">{group.name}</div>
                {members.map(item)}
              </Fragment>
            );
          })}
        </nav>
      </aside>
      <main className="workspace">
        <section className="page help-page" aria-label="帮助" ref={page}>
          <div className="page-body help-body">
            {query.trim() ? (
              <Results query={query} found={found} open={open} />
            ) : id === NEWS && news.length ? (
              <NewsView news={news} context={{ ...context, go: open }} />
            ) : current ? (
              <ArticleView article={current} list={shown} context={{ ...context, go: open }} />
            ) : (
              <Home list={shown} news={news} context={{ ...context, go: open }} />
            )}
          </div>
        </section>
      </main>
    </>
  );
}

const anchorId = (anchor: string) => `help-${anchor}`;

function Fresh({ kind }: { kind: 'new' | 'changed' }) {
  return kind === 'new' ? (
    <span className="help-new" title="这一版新增">
      新
    </span>
  ) : (
    <span className="help-new changed" title="这一版有新内容">
      更新
    </span>
  );
}

// The one line of the changelog that says what a version is about.
function summary(version: string) {
  const section = releaseSection(changelog, version);
  const line = section?.split('\n').find((text) => text.trim() && !text.startsWith('#'));
  return line?.replace(/`/g, '') ?? '';
}

// The front page: what this is in one picture, how to begin, what to try, and every subject.
function Home({ list, news, context }: { list: Article[]; news: News[]; context: Context }) {
  const { here, others, go, run, version } = context;
  const offered = starters.filter(
    (item) => (!item.device || others.length > 0) && list.some((a) => a.id === item.article),
  );
  return (
    <>
      <header className="help-hero">
        <div className="help-hero-text">
          <span className="help-kicker">CC Desk Tunnel 帮助</span>
          <h1>
            Claude Code 住在服务器上，
            <br />
            你的每台电脑都是它的手
          </h1>
          <p>会话、记忆和账号集中在服务端；项目、文件和命令留在各自的电脑上。</p>
          <div className="help-hero-actions">
            <button type="button" className="button primary" onClick={() => go('first-steps')}>
              第一次使用
              <ArrowRight />
            </button>
            <button type="button" className="button" onClick={() => go('how-it-works')}>
              它是怎么工作的
            </button>
          </div>
        </div>
        <Figure name="map" here={here} others={others} browser={context.browser} />
      </header>
      {news.length > 0 && (
        <button type="button" className="help-banner" onClick={() => go(NEWS)}>
          <Sparkles />
          <span>
            <strong>{version} 新增了什么</strong>
            <small>{summary(version) || `${news.length} 项新功能，点开看怎么用`}</small>
          </span>
          <ChevronRight />
        </button>
      )}
      <section className="help-section">
        <h2 className="help-section-title">三步开始</h2>
        <div className="help-start">
          {[
            {
              title: '添加项目',
              text: '选电脑上的一个文件夹，Claude 在那里干活。',
              target: { doing: 'addProject' } as Target,
            },
            {
              title: '说出任务',
              text: '新建会话，像在终端里用 Claude Code 一样说话。',
              target: { doing: 'newSession' } as Target,
            },
            {
              title: '看着它做',
              text: '每一步折成一行；要动手时按审批模式问你。',
              target: { article: 'approval' } as Target,
            },
          ].map((step, index) => (
            <button
              type="button"
              className="help-start-step"
              key={step.title}
              onClick={() =>
                'article' in step.target ? go(step.target.article) : run(step.target)
              }
            >
              <span className="help-step-number">{index + 1}</span>
              <strong>{step.title}</strong>
              <small>{step.text}</small>
            </button>
          ))}
        </div>
      </section>
      {offered.length > 0 && (
        <section className="help-section">
          <h2 className="help-section-title">
            试试这样说
            <small>点“试试”放进新会话的输入框，改好再发</small>
          </h2>
          <div className="help-prompts">
            {offered.slice(0, 4).map((item) => (
              <PromptCard key={item.text} prompt={item} context={context} more={item.article} />
            ))}
          </div>
        </section>
      )}
      <section className="help-section">
        <h2 className="help-section-title">按主题浏览</h2>
        <div className="help-groups">
          {groups.map((group) => {
            const members = list.filter((item) => item.group === group.id);
            if (!members.length || group.id === 'start') return null;
            return (
              <div className="help-group-card" key={group.id}>
                <div className="help-group-head">
                  <group.icon />
                  <strong>{group.name}</strong>
                </div>
                {members.map((item) => {
                  const fresh = freshness(item, version);
                  return (
                    <button
                      type="button"
                      className="help-group-link"
                      key={item.id}
                      onClick={() => go(item.id)}
                    >
                      {item.title}
                      {fresh && <Fresh kind={fresh} />}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </section>
      <footer className="help-foot">
        {project.url && (
          <button type="button" className="text-link" onClick={openProject}>
            项目主页与完整文档
            <ExternalLink />
          </button>
        )}
      </footer>
    </>
  );
}

// What the program's version brought, each with the way to its article.
function NewsView({ news, context }: { news: News[]; context: Context }) {
  const { version, go } = context;
  return (
    <article className="help-article">
      <nav className="help-crumbs" aria-label="位置">
        <button type="button" className="text-link" onClick={() => go()}>
          帮助
        </button>
        <ChevronRight />
        <span>开始使用</span>
      </nav>
      <header className="help-article-head">
        <span className="help-article-icon">
          <Sparkles />
        </span>
        <div>
          <div className="help-title-row">
            <h1>{version} 新增</h1>
          </div>
          <p className="help-lead">{summary(version) || '这一版带来的新功能，点开看怎么用。'}</p>
        </div>
      </header>
      <div className="help-news">
        {news.map((item) => (
          <button
            type="button"
            className="help-news-card"
            key={item.title}
            onClick={() => go(item.article)}
          >
            <strong>
              <item.icon />
              {item.title}
            </strong>
            <small>
              <Inline text={item.text} context={context} />
            </small>
            <span className="help-news-more">
              看怎么用
              <ArrowRight />
            </span>
          </button>
        ))}
      </div>
      <aside className="help-callout note">
        <Info />
        <div>
          <strong>完整的变更</strong>
          <p>
            每一项改动与修复见
            <InlineLink words="关于与更新" to="settings:about" context={context} />
            里的“更新内容”。文中标着“新”的段落，是这一版加的。
          </p>
        </div>
      </aside>
    </article>
  );
}

function ArticleView({
  article,
  list,
  context,
}: {
  article: Article;
  list: Article[];
  context: Context;
}) {
  const { go, version } = context;
  const group = groups.find((item) => item.id === article.group);
  const index = list.indexOf(article);
  const previous = list[index - 1];
  const next = list[index + 1];
  const related = (article.related ?? [])
    .map((id) => list.find((item) => item.id === id))
    .filter((item): item is Article => !!item);
  const fresh = freshness(article, version);
  // A long article lists its headings at the top, each a way to it.
  const headings = article.blocks.flatMap((block) =>
    block.kind === 'heading' ? [{ text: block.text, id: block.id ?? block.text }] : [],
  );
  return (
    <article className="help-article">
      <nav className="help-crumbs" aria-label="位置">
        <button type="button" className="text-link" onClick={() => go()}>
          帮助
        </button>
        <ChevronRight />
        <span>{group?.name}</span>
      </nav>
      <header className="help-article-head">
        <span className="help-article-icon">
          <article.icon />
        </span>
        <div>
          <div className="help-title-row">
            <h1>{article.title}</h1>
            {fresh === 'new' && <Fresh kind="new" />}
          </div>
          <p className="help-lead">
            <Inline text={article.lead} context={context} />
          </p>
        </div>
      </header>
      {headings.length >= 4 && (
        <nav className="help-toc" aria-label="本页内容">
          {headings.map((heading) => (
            <button
              type="button"
              key={heading.id}
              onClick={() => go(`${article.id}#${heading.id}`)}
            >
              {heading.text}
            </button>
          ))}
        </nav>
      )}
      {article.blocks.map((block, at) =>
        // Within an article that is new as a whole, nothing more is marked.
        block.since === version && fresh !== 'new' ? (
          <div className="help-fresh" key={at}>
            <span className="help-fresh-tag">{version} 新增</span>
            <BlockView block={block} context={context} />
          </div>
        ) : (
          <BlockView key={at} block={block} context={context} />
        ),
      )}
      {related.length > 0 && (
        <section className="help-related">
          <h2>相关</h2>
          <div className="help-related-list">
            {related.map((item) => (
              <button
                type="button"
                className="help-related-card"
                key={item.id}
                onClick={() => go(item.id)}
              >
                <item.icon />
                <span>
                  <strong>{item.title}</strong>
                  <small>{plain(item.lead, context)}</small>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      <footer className="help-pager">
        {previous ? (
          <button type="button" onClick={() => go(previous.id)}>
            <ArrowLeft />
            <span>
              <small>上一篇</small>
              {previous.title}
            </span>
          </button>
        ) : (
          <span />
        )}
        {next && (
          <button type="button" className="next" onClick={() => go(next.id)}>
            <span>
              <small>下一篇</small>
              {next.title}
            </span>
            <ArrowRight />
          </button>
        )}
      </footer>
    </article>
  );
}

function BlockView({ block, context }: { block: Block; context: Context }) {
  const { here, others } = context;
  switch (block.kind) {
    case 'p':
      return (
        <p className="help-p">
          <Inline text={block.text} context={context} />
        </p>
      );
    case 'heading':
      return (
        <h2 className="help-h2" id={anchorId(block.id ?? block.text)}>
          {block.text}
        </h2>
      );
    case 'list':
      return (
        <ul className="help-list">
          {block.items.map((item) => (
            <li key={item}>
              <Inline text={item} context={context} />
            </li>
          ))}
        </ul>
      );
    case 'steps':
      return (
        <ol className="help-steps">
          {block.items.map((step, index) => (
            <li key={step.title}>
              <span className="help-step-number">{index + 1}</span>
              <div>
                <strong>{step.title}</strong>
                <p>
                  <Inline text={step.text} context={context} />
                </p>
                {step.action && (
                  <TargetButton target={step.action.target} context={context}>
                    {step.action.label}
                  </TargetButton>
                )}
              </div>
            </li>
          ))}
        </ol>
      );
    case 'prompts':
      return (
        <section className="help-block">
          {block.title && <h3 className="help-h3">{block.title}</h3>}
          <div className="help-prompts">
            {block.items.map((item) => (
              <PromptCard key={item.text} prompt={item} context={context} />
            ))}
          </div>
        </section>
      );
    case 'callout': {
      const Icon = block.tone === 'tip' ? Lightbulb : block.tone === 'warn' ? TriangleAlert : Info;
      return (
        <aside className={`help-callout ${block.tone}`}>
          <Icon />
          <div>
            <strong>
              <Inline text={block.title} context={context} />
            </strong>
            <p>
              <Inline text={block.text} context={context} />
            </p>
          </div>
        </aside>
      );
    }
    case 'figure':
      return (
        <figure className="help-figure">
          <Figure name={block.name} here={here} others={others} browser={context.browser} />
          {block.caption && <figcaption>{block.caption}</figcaption>}
        </figure>
      );
    case 'code':
      return (
        <div className="help-code">
          <div className="help-code-head">
            <span>{block.label}</span>
            <CopyButton text={block.text} label="复制" />
          </div>
          <pre>
            <code>{block.text}</code>
          </pre>
        </div>
      );
    case 'table':
      return (
        <table className="help-table">
          <thead>
            <tr>
              <th>{block.head[0]}</th>
              <th>{block.head[1]}</th>
            </tr>
          </thead>
          <tbody>
            {block.rows.map(([left, right]) => (
              <tr key={left}>
                <td>
                  <Inline text={left} context={context} />
                </td>
                <td>
                  <Inline text={right} context={context} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'faq':
      return (
        <div className="help-faq">
          {block.items.map((item) => (
            <details key={item.q}>
              <summary>
                <ChevronRight />
                {item.q}
              </summary>
              {item.a.map((line) => (
                <p key={line}>
                  <Inline text={line} context={context} />
                </p>
              ))}
            </details>
          ))}
        </div>
      );
    case 'keys':
      return <Keys browser={context.browser} />;
    case 'actions':
      return (
        <div className="help-actions">
          {block.items.map((item) => (
            <TargetButton key={item.label} target={item.target} context={context}>
              {item.label}
            </TargetButton>
          ))}
        </div>
      );
  }
}

function TargetButton({
  target,
  context,
  children,
}: {
  target: Target;
  context: Context;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="button help-target"
      onClick={() => ('article' in target ? context.go(target.article) : context.run(target))}
    >
      {children}
      <ArrowRight />
    </button>
  );
}

function PromptCard({
  prompt,
  context,
  more,
}: {
  prompt: Prompt;
  context: Context;
  more?: string;
}) {
  const text = fill(prompt.text, context);
  return (
    <div className="help-prompt">
      <p className="help-prompt-text">{text}</p>
      {prompt.note && (
        <p className="help-prompt-note">
          <Inline text={prompt.note} context={context} />
        </p>
      )}
      <div className="help-prompt-actions">
        {context.tryPrompt && (
          <button
            type="button"
            className="help-try"
            title="新建一个会话，把这句话放进输入框"
            onClick={() => context.tryPrompt!(text)}
          >
            <MessageSquarePlus />
            试试
          </button>
        )}
        <CopyButton text={text} label="复制" />
        {more && (
          <button type="button" className="text-link help-more" onClick={() => context.go(more)}>
            说明
          </button>
        )}
      </div>
    </div>
  );
}

// The window's shortcuts as the user set them, and the keys of the input box.
function Keys({ browser }: { browser: boolean }) {
  const prefs = usePrefs();
  const rows = shortcutActions
    .filter((action) => !browser || !action.desktop)
    .filter((action) => !action.id.startsWith('zoom'))
    .map((action) => [
      action.name,
      prefs.shortcuts.enabled ? keyText(keyFor(prefs, action.id)) : '',
    ])
    .filter(([, keys]) => keys);
  return (
    <div className="help-keys">
      {[['命令菜单（在输入框里）', '/'], ...rows].map(([name, keys]) => (
        <div className="help-key" key={name}>
          <span>{name}</span>
          <span className="help-key-combo">
            {keys.split('+').map((key, index) => (
              <kbd key={index}>{key}</kbd>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

function Results({
  query,
  found,
  open,
}: {
  query: string;
  found: { article: Article; snippet: string }[];
  open: (id: string) => void;
}) {
  return (
    <section className="help-results">
      <h1 className="help-results-title">
        “{query.trim()}”<small>{found.length ? `${found.length} 篇` : '没有找到'}</small>
      </h1>
      {found.map(({ article, snippet }) => (
        <button
          type="button"
          className="help-result"
          key={article.id}
          onClick={() => open(article.id)}
        >
          <article.icon />
          <span>
            <strong>{article.title}</strong>
            <small>{groups.find((group) => group.id === article.group)?.name}</small>
            <em>{snippet}</em>
          </span>
          <ChevronRight />
        </button>
      ))}
      {!found.length && <p className="muted">换个说法试试，比如“额度”“其他电脑”“连不上”。</p>}
    </section>
  );
}

const fill = (text: string, { here, others }: { here: string; others: string[] }) =>
  text.replaceAll('{device}', others[0] ?? '另一台电脑').replaceAll('{here}', here);
// Text without its marks, for a line under a title and for the search.
const plain = (text: string, context: Context) =>
  fill(text, context)
    .replace(/\[\[(\w+)\]\]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*|`/g, '');

function blockText(block: Block): string[] {
  switch (block.kind) {
    case 'p':
    case 'heading':
      return [block.text];
    case 'list':
      return block.items;
    case 'steps':
      return block.items.flatMap((step) => [step.title, step.text]);
    case 'prompts':
      return [block.title ?? '', ...block.items.flatMap((item) => [item.text, item.note ?? ''])];
    case 'callout':
      return [block.title, block.text];
    case 'figure':
      return [block.caption ?? ''];
    case 'code':
      return [block.label ?? '', block.text];
    case 'table':
      return block.rows.flat();
    case 'faq':
      return block.items.flatMap((item) => [item.q, ...item.a]);
    default:
      return [];
  }
}

// Every word must be found; a match in the title counts most, then one in the lead, then one deep in the text.
function search(list: Article[], query: string, context: Context) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return list
    .map((article) => {
      const head = `${article.title} ${article.lead} ${article.words ?? ''}`.toLowerCase();
      const lines = article.blocks.flatMap(blockText).map((line) => plain(line, context));
      const body = lines.join(' ').toLowerCase();
      if (!terms.every((term) => head.includes(term) || body.includes(term))) return null;
      const title = article.title.toLowerCase();
      const score = terms.reduce(
        (sum, term) => sum + (title.includes(term) ? 6 : head.includes(term) ? 3 : 1),
        0,
      );
      const line =
        lines.find((text) => terms.some((term) => text.toLowerCase().includes(term))) ??
        plain(article.lead, context);
      return { article, snippet: line.length > 90 ? `${line.slice(0, 90)}…` : line, score };
    })
    .filter((item): item is NonNullable<typeof item> => !!item)
    .sort((a, b) => b.score - a.score);
}

// The marks of an article's text, made into what they stand for.
function Inline({ text, context }: { text: string; context: Context }) {
  const prefs = usePrefs();
  const parts = fill(text, context).split(
    /(`[^`]+`|\*\*[^*]+\*\*|\[\[\w+\]\]|\[[^\]]+\]\([^)]+\))/g,
  );
  return (
    <>
      {parts.map((part, index) => {
        if (!part) return null;
        if (part.startsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
        if (part.startsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
        if (part.startsWith('[[')) {
          const combo = keyFor(prefs, part.slice(2, -2) as Action);
          return combo ? (
            <span className="help-key-combo inline" key={index}>
              {keyText(combo)
                .split('+')
                .map((key, at) => (
                  <kbd key={at}>{key}</kbd>
                ))}
            </span>
          ) : null;
        }
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
        if (link) return <InlineLink key={index} words={link[1]} to={link[2]} context={context} />;
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}

function InlineLink({ words, to, context }: { words: string; to: string; context: Context }) {
  const external = /^https?:/.test(to);
  return (
    <button
      type="button"
      className="text-link help-inline-link"
      onClick={() => {
        if (external)
          return window.desktop ? void window.desktop.openExternal(to) : void window.open(to);
        if (to.startsWith('#')) return context.go(to.slice(1));
        const [kind, value] = to.split(':');
        if (kind === 'settings') context.run({ settings: value as never });
        else if (kind === 'do') context.run({ doing: value as never });
      }}
    >
      {words}
      {external && <ExternalLink />}
    </button>
  );
}
