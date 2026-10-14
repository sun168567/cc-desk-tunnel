import { useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => mod.default);
  }
  return mermaidPromise;
}

export default function MermaidDiagram({
  source,
  onBroken,
}: {
  source: string;
  onBroken?: () => void;
}) {
  const rawId = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  );

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setTheme(root.dataset.theme === 'dark' ? 'dark' : 'light');
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let live = true;
    const trimmed = source.trim();
    if (!trimmed) return;
    const renderId = `mermaid-${rawId}-${Date.now().toString(36)}`;
    void loadMermaid()
      .then(async (mermaid) => {
        if (!live) return;
        mermaid.initialize({
          startOnLoad: false,
          suppressErrorRendering: true,
          securityLevel: 'strict',
          theme: theme === 'dark' ? 'dark' : 'default',
          fontFamily: 'var(--font-sans)',
        });
        const result = await mermaid.render(renderId, trimmed);
        if (!live) return;
        setSvg(result.svg);
        setFailed(false);
      })
      .catch(() => {
        const orphan = document.getElementById(`d${renderId}`) ?? document.getElementById(renderId);
        orphan?.remove();
        if (!live) return;
        setFailed(true);
      });
    return () => {
      live = false;
      const orphan = document.getElementById(`d${renderId}`) ?? document.getElementById(renderId);
      orphan?.remove();
    };
  }, [source, theme, rawId, onBroken]);

  if (failed && !svg) {
    return (
      <pre className="code-mermaid-fallback">
        <code>{source}</code>
      </pre>
    );
  }

  if (!svg) {
    return (
      <div className="code-picture code-mermaid loading" aria-busy="true">
        <pre className="code-mermaid-fallback">
          <code>{source}</code>
        </pre>
      </div>
    );
  }

  return (
    <>
      <div
        className="code-picture code-mermaid"
        title="双击放大查看图表"
        onDoubleClick={(event) => {
          event.preventDefault();
          window.getSelection()?.removeAllRanges();
          setZoomed(true);
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {zoomed && (
        <div
          className="attachment-lightbox"
          role="presentation"
          onClick={() => setZoomed(false)}
        >
          <div
            className="attachment-preview mermaid-lightbox"
            role="dialog"
            aria-label="Mermaid 图表预览"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="attachment-preview-header">
              <span>Mermaid 图表</span>
              <button type="button" aria-label="关闭预览" onClick={() => setZoomed(false)}>
                <X size={15} />
              </button>
            </header>
            <div
              className="attachment-preview-body mermaid-preview-body"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        </div>
      )}
    </>
  );
}
