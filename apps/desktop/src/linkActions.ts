import { t } from './i18n.ts';
import { elsewhereText, type Link } from './links.ts';
import type { MenuItem } from './ui.tsx';

// What a click on a link does, and what its menu offers. `tell` shows a short message to the user.
type Tell = (text: string) => void;

export async function followLink(link: Link, tell: Tell) {
  try {
    if (link.kind === 'web') {
      if (window.desktop) await window.desktop.openLink(link.url);
      else window.open(link.url, '_blank', 'noopener,noreferrer');
    } else if (link.kind === 'elsewhere')
      tell(t('session:link.elsewhereHint', { reason: elsewhereText(t, link.reason) }));
    else {
      const { line, column } = link;
      const said = await window.desktop!.actOnPath('open', link.path, { line, column });
      if (said) tell(said);
    }
  } catch {
    tell(t('session:link.openFailed'));
  }
}

export async function linkMenu(
  link: Link,
  tell: Tell,
  copy: (text: string) => void,
): Promise<{ heading?: string; items: MenuItem[] }> {
  if (link.kind === 'web')
    return {
      items: [
        { label: t('session:link.openLink'), run: () => void followLink(link, tell) },
        { label: t('session:link.copyLink'), run: () => copy(link.url) },
      ],
    };
  const copyPath: MenuItem = { label: t('session:link.copyPath'), run: () => copy(link.path) };
  if (link.kind === 'elsewhere')
    return { heading: elsewhereText(t, link.reason), items: [copyPath] };
  const desktop = window.desktop!;
  const info = await desktop.inspectPath(link.path);
  const act = (action: Parameters<typeof desktop.actOnPath>[0], editor?: string) => () =>
    void desktop
      .actOnPath(action, link.path, { line: link.line, column: link.column, editor })
      .then(
        (said) => said && tell(said),
        () => tell(t('session:link.actionFailed')),
      );
  const reveal: MenuItem = { label: t('session:link.reveal'), run: act('reveal') };
  if (info.kind === 'missing') return { heading: t('session:link.missing'), items: [copyPath] };
  const runs = info.runs ? t('session:link.runs') : undefined;
  if (info.kind === 'directory')
    return {
      heading: runs,
      items: [
        ...(info.runs ? [] : [{ label: t('session:link.openFolder'), run: act('open') }]),
        reveal,
        copyPath,
      ],
    };
  const line = link.line;
  // "打开" goes to the editor when there is a line to go to, so the default application is then a choice of its own.
  const items: MenuItem[] = [
    ...(info.runs ? [] : [{ label: t('session:link.open'), run: act('open') }]),
    ...info.editors.map((editor) => ({
      label: line
        ? t('session:link.openInAt', { editor: editor.name, line })
        : t('session:link.openIn', { editor: editor.name }),
      run: act('editor', editor.scheme),
    })),
    ...(!info.runs && link.line && info.editors.length
      ? [{ label: t('session:link.openDefault'), run: act('default') }]
      : []),
    ...(!info.runs && info.openWith
      ? [{ label: t('session:link.openWith'), run: act('with') }]
      : []),
  ];
  return {
    heading: runs,
    items: [
      ...items,
      { ...reveal, separated: items.length > 0 },
      copyPath,
      { label: t('session:link.copyContent'), run: act('content') },
      { label: t('session:link.saveAs'), run: act('save') },
    ],
  };
}
