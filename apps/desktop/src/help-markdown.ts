import type { T } from '@cc-desk-tunnel/i18n';
import { groupName, groups, helpArticles } from './help-content.ts';
import type { Article, Block, Target } from './help-content.ts';

// The help as Markdown files, for Claude to read on the server: the same articles the clients show, a file each, and
// an index of them by group. scripts/help-markdown.mjs writes them where the service tells Claude to look (see
// `ClaudeOptions.help`). What the window would do for a link is said in words: an article is a link to its file, a
// settings page is named, a shortcut is named by its action, and the name of another computer is a stand-in.
export function helpMarkdown(t: T): { name: string; text: string }[] {
  const articles = helpArticles(t);
  const titles = new Map(articles.map((article) => [article.id, article.title]));
  const page = (section: string) =>
    t('help:model.settingsPage', { section: t(`settings:section.${section}.name` as never) });
  const words = (text: string) =>
    text
      .replaceAll('{device}', t('help:anotherComputer'))
      .replaceAll('{here}', t('help:model.here'))
      .replace(/\[\[(\w+)\]\]/g, (_, action: string) =>
        t('help:model.shortcut', { action: t(`settings:shortcut.action.${action}` as never) }),
      )
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (link, said: string, to: string) => {
        if (/^https?:/.test(to)) return link;
        if (to.startsWith('#')) {
          const [article, heading] = to.slice(1).split('#');
          return `[${said}](${article}.md${heading ? `#${heading}` : ''})`;
        }
        const [kind, value] = to.split(':');
        return kind === 'settings'
          ? t('help:model.settingsLink', {
              words: said,
              section: t(`settings:section.${value}.name` as never),
            })
          : said;
      });
  const target = (to: Target) =>
    'article' in to
      ? `[${titles.get(to.article) ?? to.article}](${to.article}.md)`
      : 'settings' in to
        ? page(to.settings)
        : undefined;
  const block = (item: Block): string => {
    switch (item.kind) {
      case 'p':
        return words(item.text);
      case 'heading':
        return `<a id="${item.id}"></a>\n\n## ${words(item.text)}`;
      case 'list':
        return item.items.map((text) => `- ${words(text)}`).join('\n');
      case 'steps':
        return item.items
          .map((step, index) => {
            const to = step.action && target(step.action.target);
            return [
              `${index + 1}. **${words(step.title)}**`,
              `   ${words(step.text)}`,
              ...(step.action ? [`   → ${words(step.action.label)}${to ? `: ${to}` : ''}`] : []),
            ].join('\n');
          })
          .join('\n');
      case 'prompts':
        return [
          ...(item.title ? [`**${words(item.title)}**`] : []),
          ...item.items.map(
            ({ text, note }) => `> ${words(text)}${note ? `\n>\n> *${words(note)}*` : ''}`,
          ),
        ].join('\n\n');
      case 'callout':
        return `> **${words(item.title)}**\n>\n> ${words(item.text)}`;
      case 'figure':
        return item.caption ? `*${words(item.caption)}*` : '';
      case 'code':
        return `${item.label ? `${words(item.label)}\n\n` : ''}\`\`\`\n${item.text}\n\`\`\``;
      case 'table':
        return [
          `| ${item.head.map(words).join(' | ')} |`,
          '| --- | --- |',
          ...item.rows.map((row) => `| ${row.map(words).join(' | ')} |`),
        ].join('\n');
      case 'faq':
        return item.items
          .map(({ q, a }) => [`**${words(q)}**`, ...a.map(words)].join('\n\n'))
          .join('\n\n');
      case 'keys':
        return t('help:model.keys');
      case 'actions':
        return item.items
          .map(({ label, target: to }) => {
            const where = target(to);
            return `- ${words(label)}${where ? `: ${where}` : ''}`;
          })
          .join('\n');
    }
  };
  const file = (article: Article) => {
    const parts = [
      `# ${article.title}`,
      words(article.lead),
      ...(article.desktop ? [`*${t('help:model.desktopOnly')}*`] : []),
      ...article.blocks.map(block),
      ...(article.related?.length
        ? [
            `**${t('help:model.related')}**`,
            article.related.map((id) => `- [${titles.get(id) ?? id}](${id}.md)`).join('\n'),
          ]
        : []),
    ];
    return parts.filter(Boolean).join('\n\n') + '\n';
  };
  const index = [
    `# ${t('help:page.kicker')}`,
    t('help:model.intro'),
    ...groups.flatMap(({ id }) => {
      const listed = articles.filter((article) => article.group === id);
      return listed.length
        ? [
            `## ${groupName(t, id)}`,
            listed
              .map((article) => `- [${article.title}](${article.id}.md): ${words(article.lead)}`)
              .join('\n'),
          ]
        : [];
    }),
  ];
  return [
    { name: 'index.md', text: index.join('\n\n') + '\n' },
    ...articles.map((article) => ({ name: `${article.id}.md`, text: file(article) })),
  ];
}
