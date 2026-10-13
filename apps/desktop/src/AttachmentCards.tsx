import { useContext, useEffect, useState } from 'react';
import { FileCode2, FileImage, FileText, X } from 'lucide-react';
import type { Attachment, Preview } from './attachments.ts';
import { OpenDocument, paneKind } from './file-preview.ts';

const imagePath = (path: string) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(path);
const codePath = (path: string) =>
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|c|cc|cpp|h|hpp|cs|java|json|ya?ml|toml|sh|ps1|bat|css|html|sql|vue|svelte)$/i.test(
    path,
  );
const fileName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
const fileBadge = (path: string) => {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'FILE';
  return name.slice(dot + 1, dot + 5).toUpperCase();
};

export function AttachmentCards({
  items,
  remove,
  stored = false,
}: {
  items: Attachment[];
  remove?: (path: string) => void;
  stored?: boolean;
}) {
  const openDocument = useContext(OpenDocument);
  const [opened, setOpened] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    for (const item of items) {
      if (!imagePath(item.path) || item.preview) continue;
      void window
        .desktop!.previewFile(item.path)
        .then((value) => {
          if (live) setPreviews((current) => ({ ...current, [item.path]: value }));
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [items]);
  useEffect(() => {
    if (opened && !items.some((item) => item.path === opened)) setOpened(null);
  }, [items, opened]);
  async function enlarge(item: Attachment) {
    if (paneKind(item.path)) {
      openDocument({ path: item.path, fallback: '' });
      return;
    }
    setOpened(item.path);
    setError('');
    if (stored || item.preview || previews[item.path]) return;
    try {
      const value = await window.desktop!.previewFile(item.path);
      setPreviews((current) => ({ ...current, [item.path]: value }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法预览');
    }
  }
  if (!window.desktop || !items.length) return null;
  const openItem = items.find((item) => item.path === opened);
  const openPreview = openItem ? (openItem.preview ?? previews[openItem.path]) : undefined;
  return (
    <>
      <div className={`attachment-cards ${stored ? 'stored' : ''}`}>
        {items.map((item) => {
          const preview = item.preview ?? previews[item.path];
          const thumb =
            preview?.kind === 'image' && preview.data.startsWith('data:image/')
              ? preview.data
              : null;
          const isImg = imagePath(item.path);
          const isCode = codePath(item.path);
          const badge = isImg ? 'IMG' : fileBadge(item.path);
          return (
            <div className={`attachment-card ${thumb ? 'has-thumb' : ''}`} key={item.path}>
              <button
                type="button"
                className="attachment-name"
                title={`${item.path}\n${isImg ? '双击放大预览' : '双击在右侧预览'}`}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  void enlarge(item);
                }}
              >
                {thumb ? (
                  <img className="attachment-thumb" src={thumb} alt="" />
                ) : (
                  <span className="attachment-icon" aria-hidden="true">
                    {isImg ? (
                      <FileImage size={16} />
                    ) : isCode ? (
                      <FileCode2 size={16} />
                    ) : (
                      <FileText size={16} />
                    )}
                  </span>
                )}
                <span className="attachment-meta">
                  <strong className="attachment-title">{fileName(item.path)}</strong>
                  <small className="attachment-kind">{badge}</small>
                </span>
              </button>
              {remove && (
                <button
                  type="button"
                  className="attachment-remove"
                  aria-label={`移除 ${fileName(item.path)}`}
                  title="移除附件"
                  onClick={() => remove(item.path)}
                >
                  <X size={13} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {openItem && (
        <div className="attachment-lightbox" role="presentation" onClick={() => setOpened(null)}>
          <div
            className="attachment-preview"
            role="dialog"
            aria-label={fileName(openItem.path)}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="attachment-preview-header">
              <span>{fileName(openItem.path)}</span>
              <button type="button" aria-label="关闭预览" onClick={() => setOpened(null)}>
                <X size={15} />
              </button>
            </header>
            <div className="attachment-preview-body">
              {openPreview?.kind === 'image' && openPreview.data.startsWith('data:image/') ? (
                <img src={openPreview.data} alt={fileName(openItem.path)} />
              ) : openPreview?.kind === 'text' ? (
                <pre>
                  {openPreview.text}
                  {openPreview.truncated ? '\n…（已截断）' : ''}
                </pre>
              ) : (
                <p className="muted">
                  {openPreview?.kind === 'unavailable'
                    ? openPreview.reason
                    : error || (stored ? '无法预览' : '正在读取…')}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
export function useMessageAttachments(messageId: string) {
  const [items, setItems] = useState<Attachment[]>([]);
  useEffect(() => {
    let current = true;
    if (window.desktop)
      void window.desktop
        .loadAttachments(messageId)
        .then((value) => {
          if (current) setItems(value);
        })
        .catch(() => {});
    return () => {
      current = false;
    };
  }, [messageId]);
  return items;
}

export function MessageAttachments({ messageId }: { messageId: string }) {
  const items = useMessageAttachments(messageId);
  return <AttachmentCards items={items} stored />;
}
