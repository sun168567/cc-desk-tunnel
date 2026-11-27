import { CircleHelp } from 'lucide-react';
import { openHelp } from './help-nav.ts';
import { useT } from './i18n.ts';
import './help-link.css';

// A small "?" beside a control whose name and a few words cannot say everything: it opens the help at the article
// that explains it. It is named by `title`, else as help on `subject`, the name of what it stands beside.
export default function HelpLink({
  article,
  title,
  subject,
  className = '',
  onOpen,
}: {
  article: string;
  title?: string;
  subject?: string;
  className?: string;
  // Before the help opens: a dialog closes itself.
  onOpen?: () => void;
}) {
  const t = useT();
  title ??= subject ? t('common:helpFor', { subject }) : t('common:help');
  return (
    <button
      type="button"
      className={`help-link ${className}`}
      title={title}
      aria-label={title}
      onClick={(event) => {
        event.stopPropagation();
        onOpen?.();
        openHelp(article);
      }}
    >
      <CircleHelp />
    </button>
  );
}
