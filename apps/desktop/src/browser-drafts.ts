import type { Drafts } from './drafts.ts';

const viewKey = 'remote-drafts';
const backupPrefix = 'remote-draft:';
type StorageArea = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

function read(text: string | null): Drafts {
  try {
    const value: unknown = JSON.parse(text ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
      ),
    );
  } catch {
    return {};
  }
}

// Each tab keeps its own draft map across reloads. Per-session backups let a new tab recover the
// browser's latest edits without one tab replacing another session's saved work as a whole map.
export function createBrowserDrafts(backup: StorageArea, view: StorageArea) {
  let previous: Drafts | undefined;
  function load(): Drafts {
    const legacy = backup.getItem(viewKey);
    const recovered = { ...read(legacy) };
    for (const key of Array.from({ length: backup.length }, (_, index) => backup.key(index))) {
      if (key?.startsWith(backupPrefix))
        recovered[key.slice(backupPrefix.length)] = backup.getItem(key) ?? '';
    }
    const saved = view.getItem(viewKey);
    const drafts =
      saved === null
        ? Object.fromEntries(Object.entries(recovered).filter(([, text]) => text !== ''))
        : read(saved);
    // A full storage area must not hide readable drafts merely because migration or the initial
    // tab snapshot needs extra space. Keep the legacy map until every backup has been copied.
    try {
      view.setItem(viewKey, JSON.stringify(drafts));
    } catch {}
    if (legacy !== null) {
      try {
        for (const [id, text] of Object.entries(read(legacy))) {
          if (backup.getItem(backupPrefix + id) === null) backup.setItem(backupPrefix + id, text);
        }
        backup.removeItem(viewKey);
      } catch {}
    }
    previous = drafts;
    return { ...drafts };
  }
  return {
    load,
    save(drafts: Drafts) {
      const before = previous ?? load();
      view.setItem(viewKey, JSON.stringify(drafts));
      const legacy = read(backup.getItem(viewKey));
      // Only this view's edits affect recovery backups. Merely loading or refreshing an older tab
      // must not restore stale text, including text already sent from another tab.
      for (const id of new Set([...Object.keys(before), ...Object.keys(drafts)])) {
        if (before[id] === drafts[id]) continue;
        if (drafts[id]) backup.setItem(backupPrefix + id, drafts[id]);
        else if ((backup.getItem(backupPrefix + id) ?? legacy[id]) === before[id]) {
          if (legacy[id]) {
            delete legacy[id];
            // Shrinking the existing map also works when there is no room for a new backup key.
            backup.setItem(viewKey, JSON.stringify(legacy));
          }
          backup.removeItem(backupPrefix + id);
        }
      }
      previous = { ...drafts };
    },
  };
}
