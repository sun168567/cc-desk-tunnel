import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import RichText from './RichText.tsx';
import { highlightSource, languageOf } from './code-highlight.ts';
import { paneKind } from './file-preview.ts';
import { IconButton } from './ui.tsx';

// Uploaded HTML is drawn as a page fragment. Scripts and inline handlers are removed; the page
// still refuses frames, so this cannot become a nested browser.
function drawnHtml(raw: string) {
  const parsed = new DOMParser().parseFromString(raw, 'text/html');
  parsed
    .querySelectorAll('script,style,iframe,object,embed,link,meta,base,form')
    .forEach((node) => node.remove());
  for (const element of parsed.body.querySelectorAll('*')) {
    for (const attr of [...element.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'style') element.removeAttribute(attr.name);
      else if ((name === 'href' || name === 'src') && value.startsWith('javascript:'))
        element.removeAttribute(attr.name);
    }
  }
  return parsed.body.innerHTML;
}

function HtmlView({ html }: { html: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const root = node.shadowRoot ?? node.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host { display: block; font: 14px/1.65 sans-serif; color: inherit; }
      img, video, svg { max-width: 100%; height: auto; }
      pre, code { font-family: ui-monospace, monospace; white-space: pre-wrap; }
      table { border-collapse: collapse; max-width: 100%; }
      a { color: #2563eb; }
    </style>${drawnHtml(html)}`;
  }, [html]);
  return <div className="file-drawer-html" ref={host} />;
}

const fileName = (filePath: string) => filePath.split(/[\\/]/).pop() ?? filePath;

export default function FileDrawer({
  path,
  fallback,
  onClose,
}: {
  path: string;
  fallback: string;
  onClose: () => void;
}) {
  const [text, setText] = useState(fallback);
  const [truncated, setTruncated] = useState(false);
  const [notice, setNotice] = useState('');
  const kind = paneKind(path);
  useEffect(() => {
    setText(fallback);
    setTruncated(false);
    setNotice('');
    if (!window.desktop) return;
    let live = true;
    void window.desktop
      .readTextFile(path)
      .then((value) => {
        if (!live) return;
        if (!value.text && fallback) return;
        setText(value.text);
        setTruncated(value.truncated);
      })
      .catch(() => {
        if (live && !fallback) setNotice('读不到这个文件。');
      });
    return () => {
      live = false;
    };
  }, [path, fallback]);
  const highlighted =
    kind === 'source' ? highlightSource(text, languageOf(path)) : null;
  return (
    <aside className="file-drawer" aria-label={fileName(path)}>
      <header>
        <div>
          <strong>{fileName(path)}</strong>
          <small title={path}>{path}</small>
        </div>
        <IconButton title="关闭预览" onClick={onClose}>
          <X />
        </IconButton>
      </header>
      <div className="file-drawer-body">
        {notice && <p role="alert">{notice}</p>}
        {kind === 'markdown' ? (
          <div className="message-content">
            <RichText text={text} />
          </div>
        ) : kind === 'html' ? (
          <HtmlView html={text} />
        ) : highlighted ? (
          <pre className="file-drawer-source" dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <pre className="file-drawer-source">{text}</pre>
        )}
        {truncated && <p className="file-drawer-note">只显示了前 1 MB。</p>}
      </div>
    </aside>
  );
}
