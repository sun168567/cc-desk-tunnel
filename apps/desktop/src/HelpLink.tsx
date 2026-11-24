import { CircleHelp } from 'lucide-react';
import { openHelp } from './help-nav.ts';
import './help-link.css';

// A small "?" beside a control whose name and a few words cannot say everything: it opens the help at the article
// that explains it.
export default function HelpLink({
  article,
  title = '说明',
  className = '',
}: {
  article: string;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`help-link ${className}`}
      title={title}
      aria-label={title}
      onClick={(event) => {
        event.stopPropagation();
        openHelp(article);
      }}
    >
      <CircleHelp />
    </button>
  );
}
