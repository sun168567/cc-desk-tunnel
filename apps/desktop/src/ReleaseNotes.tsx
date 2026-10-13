import { useEffect, useState } from 'react';
import changelog from '../../../CHANGELOG.md?raw';
import { absoluteLinks, releaseSection } from './notes.ts';
import { project } from './project.tsx';
import RichText from './RichText.tsx';
import { Modal } from './ui.tsx';

// What changed in a version, shown where the user decides about an upgrade. This program carries the notes up
// to its own version; those of a newer one are read from that release's page on GitHub, and when that cannot
// be reached the page is offered instead.
export default function ReleaseNotes({
  version,
  onClose,
}: {
  version: string;
  onClose: () => void;
}) {
  const carried = releaseSection(changelog, version);
  const [fetched, setFetched] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (carried) return;
    if (!window.desktop) return setFailed(true);
    let current = true;
    window.desktop.releaseNotes(version).then(
      (text) => current && (text ? setFetched(text) : setFailed(true)),
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, [carried, version]);
  const text = carried ? absoluteLinks(carried, project.url, version) : fetched;
  const page = `${project.url}/releases/tag/v${version}`;
  return (
    <Modal title={`${version} 的更新内容`} onClose={onClose}>
      <div
        className="release-notes"
        // The window opens no page itself: a link goes to the user's browser.
        onClick={(event) => {
          const link = (event.target as HTMLElement).closest('a');
          if (!link?.href || !window.desktop) return;
          event.preventDefault();
          void window.desktop.openExternal(link.href).catch(() => {});
        }}
      >
        {text ? (
          <RichText text={text} />
        ) : (
          <p className="muted">
            {failed ? '没能从 GitHub 读到这一版的说明，可以到发布页查看。' : '正在读取…'}
          </p>
        )}
      </div>
      <div className="setting-actions">
        {project.url && (
          <button
            type="button"
            className="button"
            onClick={() =>
              window.desktop ? void window.desktop.openExternal(page) : window.open(page)
            }
          >
            在 GitHub 发布页查看
          </button>
        )}
        <button type="button" className="button primary" onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}
