import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from './i18n.ts';
import { Modal } from './ui.tsx';

// A picture whole, until closed.
export function PictureDialog({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const t = useT();
  return createPortal(
    <Modal title={alt || t('session:picture.title')} onClose={onClose}>
      <div className="picture-view" onContextMenu={(event) => event.stopPropagation()}>
        <img src={src} alt={alt} />
      </div>
    </Modal>,
    document.body,
  );
}

// A picture in the conversation, small where it stands; a click shows it whole until closed. `link` is the path
// it came from, for the conversation's menu of a linked file.
export function Picture({
  src,
  alt,
  link,
  title,
  onError,
}: {
  src: string;
  alt: string;
  link?: string;
  title?: string;
  onError?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="picture"
        title={title ?? t('session:picture.enlarge')}
        data-link={link}
        onClick={() => setOpen(true)}
      >
        <img src={src} alt={alt} onError={onError} />
      </button>
      {open && <PictureDialog src={src} alt={alt} onClose={() => setOpen(false)} />}
    </>
  );
}
