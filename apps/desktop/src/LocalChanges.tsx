import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { countChanges } from './edit-input.ts';
import type { Turn } from './transcript.ts';

const CodeDiff = lazy(() => import('./CodeDiff.tsx'));

// Turns snapshotted in this window. Older history has no baseline, so it is not asked.
const watched = new Set<string>();
export function watchProject(id: string) {
  watched.add(id);
}
export function forgetProject(id: string) {
  watched.delete(id);
}

type FileChange = { path: string; oldText: string; newText: string };

const fileName = (filePath: string) => filePath.split(/[\\/]/).pop() ?? filePath;

// A shell command still in progress has not left the files in their final state.
function settled(turn: Turn) {
  if (!turn.endedAt) return false;
  for (const step of turn.steps) {
    if (step.kind !== 'work') continue;
    for (const item of step.items) {
      if (item.kind !== 'tool') continue;
      if (item.name !== 'Bash' && item.name !== 'PowerShell') continue;
      if (!item.endedAt && item.state !== 'denied' && item.state !== 'cancelled') return false;
    }
  }
  return true;
}

export default function LocalChanges({ turn, omit }: { turn: Turn; omit: string }) {
  const id = turn.question?.id;
  const ready = settled(turn);
  const [files, setFiles] = useState<FileChange[] | null>(null);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!id || !ready || !window.desktop || !watched.has(id)) return;
    let live = true;
    void window.desktop
      .finishProjectDiff(id)
      .then((value) => {
        if (live) setFiles(value ?? []);
      })
      .catch(() => {
        if (live) setFiles([]);
      });
    return () => {
      live = false;
    };
  }, [id, ready]);
  const shown = useMemo(() => {
    const skipped = new Set(omit ? omit.split('\0') : []);
    return (files ?? []).filter((file) => !skipped.has(file.path));
  }, [files, omit]);
  const counts = useMemo(
    () =>
      shown.map((file) => ({
        file,
        ...countChanges({
          kind: 'Edit',
          path: file.path,
          changes: [{ oldText: file.oldText, newText: file.newText }],
        }),
      })),
    [shown],
  );
  if (!counts.length) return null;
  return (
    <div className="changed-files" aria-label="本轮文件改动">
      <span>本轮文件改动</span>
      {counts.map(({ file, added, removed }) => {
        const open = opened.has(file.path);
        return (
          <div key={file.path}>
            <button
              type="button"
              title={file.path}
              aria-expanded={open}
              onClick={() =>
                setOpened((current) => {
                  const next = new Set(current);
                  if (next.has(file.path)) next.delete(file.path);
                  else next.add(file.path);
                  return next;
                })
              }
            >
              <span>{fileName(file.path)}</span>
              <ins>+{added}</ins>
              <del>−{removed}</del>
            </button>
            {open && (
              <Suspense fallback={null}>
                <CodeDiff
                  input={{
                    kind: 'Edit',
                    path: file.path,
                    changes: [{ oldText: file.oldText, newText: file.newText }],
                  }}
                />
              </Suspense>
            )}
          </div>
        );
      })}
    </div>
  );
}
