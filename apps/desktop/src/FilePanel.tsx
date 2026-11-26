import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { Tree } from 'react-arborist';
import type { NodeRendererProps } from 'react-arborist';
import {
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  Expand,
  File,
  FileCode,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  Laptop,
  Maximize2,
  Minimize2,
  Monitor,
  Pencil,
  RefreshCw,
  Server,
  ShieldAlert,
  SquareArrowOutUpRight,
  Trash2,
  Upload,
  X,
  ServerOff,
} from 'lucide-react';
import { useT } from './i18n.ts';
import RichText from './RichText.tsx';
import './file-panel.css';
import { copyText } from './copy.tsx';
import {
  baseName,
  crumbs,
  formatSize,
  formatTime,
  isDirectory,
  joinPath,
  parentOf,
  previewOf,
  within,
} from './files.ts';
import type { FileEntry, FilePlace, FilesInfo, Preview } from './files.ts';
import { IconButton, Menu, Modal } from './ui.tsx';
import type { MenuItem, MenuPosition } from './ui.tsx';
import HelpLink from './HelpLink.tsx';

// The file panel: the files of this computer, of the service and of the user's other connected computers, in a
// tree with a preview beside it, and what is copied between them. It is as wide as the user makes it; wide
// enough, the tree and the preview sit side by side, and as a page of its own the folder's list goes between
// them. Everything is done by the desktop's main process (window.desktop.files, see electron/files.mjs): this
// computer's files directly, the others over SFTP.

type Node = { id: string; name: string; entry: FileEntry; children?: Node[] };
type Folder = { entries?: FileEntry[]; error?: string };
type Transfer = {
  id: string;
  label: string;
  request: Parameters<NonNullable<Window['desktop']>['files']['transfer']>[1];
  done: number;
  total: number;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  error?: string;
};
type Ask =
  | { kind: 'name'; title: string; value: string; resolve: (value: string | null) => void }
  | { kind: 'confirm'; title: string; text: string; resolve: (value: boolean) => void }
  | {
      kind: 'conflict';
      names: string[];
      resolve: (value: 'replace' | 'skip' | 'resume' | null) => void;
    };
export type PanelLayout = 'narrow' | 'wide' | 'page';

const api = () => window.desktop!.files;
// How long a finished copy stays in the list under the panel.
const KEEP_DONE_MS = 6000;
// How many lines of a text file are drawn; the rest is said, not shown.
const SHOWN_LINES = 5000;

const sorted = (entries: FileEntry[]) =>
  [...entries].sort(
    (a, b) =>
      Number(isDirectory(b)) - Number(isDirectory(a)) ||
      a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }),
  );
function iconOf(name: string, directory = false, open = false) {
  if (directory) return open ? <FolderOpen /> : <Folder />;
  if (/\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i.test(name))
    return <FileImage className="file-icon image" />;
  if (/\.(md|markdown|txt|log|rst)$/i.test(name) || !name.includes('.'))
    return <FileText className="file-icon text" />;
  if (
    /\.(tsx?|jsx?|c?js|mjs|json|css|s?html?|ya?ml|toml|py|go|rs|java|kt|cs|cpp|c|h|sh|ps1|sql|vue|rb|php)$/i.test(
      name,
    )
  )
    return <FileCode className="file-icon code" />;
  return <File className="file-icon" />;
}
const placeIcon = (place: FilePlace) =>
  place.kind === 'local' ? <Laptop /> : place.kind === 'server' ? <Server /> : <Monitor />;

export default function FilePanel({
  places,
  start,
  sessionKey,
  info,
  layout,
  setPage,
  close,
  noticeKey,
  project,
  request,
  aliasOf,
}: {
  places: FilePlace[];
  // Where the panel opens in a place for the selected session, or null for wherever the place starts.
  start: (place: FilePlace) => string | null;
  // Changes when another session is selected, which the panel then follows.
  sessionKey: string;
  info: FilesInfo | null;
  layout: PanelLayout;
  setPage: (page: boolean) => void;
  close: () => void;
  // Names the service, so that its notice once closed stays closed.
  noticeKey: string;
  // The selected session's project on this computer, whose changes git tells.
  project: string | null;
  // A path to show, from a link in the conversation; a new `at` asks again.
  request?: { place: string; path: string; at: number } | null;
  // What a directory of the service's is for, where its name does not tell (see `nativeLabels`).
  aliasOf: (name: string) => string | undefined;
}) {
  const t = useT();
  const [placeId, setPlaceId] = useState(() => places.find((place) => start(place))?.id ?? 'local');
  const place = places.find((entry) => entry.id === placeId) ?? places[0]!;
  const style = place.style;
  const alias = (name: string) => (place.kind === 'server' ? aliasOf(name) : undefined);
  const aliasMark = (name: string) => {
    const label = alias(name);
    return label && <small className="file-alias">{label}</small>;
  };
  const [root, setRoot] = useState<string | null>(null);
  const [folders, setFolders] = useState<Record<string, Folder>>({});
  const [selected, setSelected] = useState<string | null>(null);
  // The folder the list shows, as a page, and where new things go: the one last opened or of the file selected.
  const [current, setCurrent] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    path: string;
    size: number;
    truncated: boolean;
    shown: Preview | null;
    error?: string;
    source?: boolean;
  } | null>(null);
  const [reading, setReading] = useState(false);
  const [filter, setFilter] = useState('');
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [clipboard, setClipboard] = useState<{ place: string; paths: string[] } | null>(null);
  const [menu, setMenu] = useState<(MenuPosition & { items: MenuItem[] }) | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [changes, setChanges] = useState<{ path: string; status: string }[] | null>(null);
  const [noticeClosed, setNoticeClosed] = useState(
    () => localStorage.getItem(`files-notice:${noticeKey}`) === 'closed',
  );
  const generation = useRef(0);

  const load = useCallback(
    async (directory: string) => {
      const at = generation.current;
      try {
        const entries = await api().list(place.id, directory);
        if (at === generation.current) setFolders((all) => ({ ...all, [directory]: { entries } }));
      } catch (error) {
        if (at === generation.current)
          setFolders((all) => ({ ...all, [directory]: { error: (error as Error).message } }));
      }
    },
    [place.id],
  );
  // Opens a place at a folder: the session's, or where the place starts.
  const go = useCallback(
    async (directory?: string | null) => {
      generation.current++;
      setFolders({});
      setSelected(null);
      setPreview(null);
      setMessage(null);
      // A service whose image has no SFTP server has nothing to list; the panel says so instead.
      if (place.kind === 'server' && info && !info.server) {
        setRoot(null);
        return;
      }
      let where = directory ?? start(place);
      if (!where)
        try {
          where = await api().home(place.id);
        } catch (error) {
          setRoot(null);
          setMessage((error as Error).message);
          return;
        }
      setRoot(where);
      setCurrent(where);
      void load(where);
    },
    [place, start, load, info],
  );
  // A path asked for opens its folder, and the file itself; one in another place waits for that place.
  const pending = useRef<{ place: string; path: string } | null>(null);
  // Whether the panel has opened its first place, before which a request waits for it.
  const opened = useRef(false);
  async function reveal(path: string) {
    let directory = true;
    try {
      directory = (await api().stat(place.id, path)).kind === 'directory';
    } catch (error) {
      setMessage((error as Error).message);
      return;
    }
    await go(directory ? path : parentOf(style, path));
    if (!directory) void show(path);
  }
  useEffect(() => {
    if (!request) return;
    pending.current = { place: request.place, path: request.path };
    if (request.place !== placeId) setPlaceId(request.place);
    else if (opened.current) {
      pending.current = null;
      void reveal(request.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.at]);
  useEffect(() => {
    opened.current = true;
    const asked = pending.current;
    if (asked?.place === place.id) {
      pending.current = null;
      void reveal(asked.path);
      return;
    }
    void go();
    // A new session or place opens where it belongs; nothing else moves the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, place.id]);
  useEffect(() => {
    if (place.kind !== 'local' || !project) return setChanges(null);
    let live = true;
    void api()
      .changes(project)
      .then((found) => live && setChanges(found));
    return () => {
      live = false;
    };
  }, [place.kind, project, folders]);
  useEffect(
    () =>
      api().onProgress((id, report) =>
        setTransfers((all) =>
          all.map((transfer) =>
            transfer.id === id ? { ...transfer, done: report.done, total: report.total } : transfer,
          ),
        ),
      ),
    [],
  );
  // Finished copies leave the list after a while; failed ones stay to be resumed.
  useEffect(() => {
    if (!transfers.some((transfer) => transfer.state === 'done' || transfer.state === 'cancelled'))
      return;
    const timer = setTimeout(
      () =>
        setTransfers((all) =>
          all.filter((transfer) => transfer.state === 'running' || transfer.state === 'failed'),
        ),
      KEEP_DONE_MS,
    );
    return () => clearTimeout(timer);
  }, [transfers]);

  const refresh = () => {
    for (const directory of Object.keys(folders)) void load(directory);
    if (preview) void show(preview.path);
  };
  const reloadAround = (paths: string[]) => {
    for (const directory of new Set(paths.map((path) => parentOf(style, path))))
      void load(directory);
  };
  async function show(path: string) {
    setSelected(path);
    setCurrent(parentOf(style, path));
    setPreview({ path, size: 0, truncated: false, shown: null });
    try {
      const read = await api().read(place.id, path);
      const shown = previewOf(baseName(style, path), read.bytes);
      setPreview((now) =>
        now?.path === path ? { path, size: read.size, truncated: read.truncated, shown } : now,
      );
    } catch (error) {
      setPreview((now) =>
        now?.path === path
          ? { path, size: 0, truncated: false, shown: null, error: (error as Error).message }
          : now,
      );
    }
  }
  useEffect(
    () => () => {
      if (preview?.shown?.kind === 'image') URL.revokeObjectURL(preview.shown.url);
    },
    [preview],
  );

  const askFor = <T,>(request: (resolve: (value: T) => void) => Ask) =>
    new Promise<T>((resolve) =>
      setAsk(
        request((value) => {
          setAsk(null);
          resolve(value);
        }),
      ),
    );
  // Copies into a folder of a place, asking first when names there are taken.
  async function copy(
    from: { place: string; paths: string[] },
    to: { place: FilePlace; dir: string },
  ) {
    const names = from.paths.map((path) =>
      baseName(from.place === 'local' ? places[0]!.style : 'posix', path),
    );
    let conflict: 'replace' | 'skip' | 'resume' = 'replace';
    try {
      const taken = await api().exists(to.place.id, to.dir, names);
      const clashing = names.filter((_name, index) => taken[index]);
      if (clashing.length) {
        const answer = await askFor<'replace' | 'skip' | 'resume' | null>((resolve) => ({
          kind: 'conflict',
          names: clashing,
          resolve,
        }));
        if (!answer) return;
        conflict = answer;
      }
    } catch (error) {
      setMessage((error as Error).message);
      return;
    }
    const fromLabel = places.find((entry) => entry.id === from.place)?.label ?? '';
    run({
      label: t('files:transfer.label', {
        what: names.length === 1 ? names[0] : t('files:items', { count: names.length }),
        from: fromLabel,
        to: to.place.label,
      }),
      request: {
        from: { target: from.place, paths: from.paths },
        to: { target: to.place.id, dir: to.dir },
        conflict,
      },
    });
  }
  function run({ label, request }: Pick<Transfer, 'label' | 'request'>) {
    const id = crypto.randomUUID();
    setTransfers((all) => [...all, { id, label, request, done: 0, total: 0, state: 'running' }]);
    const finish = (change: Partial<Transfer>) =>
      setTransfers((all) =>
        all.map((transfer) => (transfer.id === id ? { ...transfer, ...change } : transfer)),
      );
    api()
      .transfer(id, request)
      .then(
        (result) => {
          if (result.cancelled) return finish({ state: 'cancelled' });
          finish({ state: 'done', done: result.bytes, total: result.bytes });
          if (request.to.target === place.id) void load(request.to.dir);
        },
        (error: Error) => finish({ state: 'failed', error: error.message }),
      );
  }

  async function makeFolder(directory: string) {
    const name = await askFor<string | null>((resolve) => ({
      kind: 'name',
      title: t('files:newFolder'),
      value: '',
      resolve,
    }));
    if (!name) return;
    await act(
      () => api().mkdir(place.id, joinPath(style, directory, name)),
      [joinPath(style, directory, name)],
    );
  }
  async function renameEntry(path: string) {
    const name = await askFor<string | null>((resolve) => ({
      kind: 'name',
      title: t('files:rename'),
      value: baseName(style, path),
      resolve,
    }));
    if (!name || name === baseName(style, path)) return;
    const to = joinPath(style, parentOf(style, path), name);
    await act(() => api().rename(place.id, path, to), [path]);
    if (selected === path) void show(to);
  }
  async function removeEntries(paths: string[]) {
    const yes = await askFor<boolean>((resolve) => ({
      kind: 'confirm',
      title: t('files:delete.title'),
      text:
        paths.length === 1
          ? t(place.kind === 'local' ? 'files:delete.one' : 'files:delete.oneRemote', {
              name: baseName(style, paths[0]!),
            })
          : t('files:delete.many', { count: paths.length }),
      resolve,
    }));
    if (!yes) return;
    await act(() => api().remove(place.id, paths), paths);
    if (preview && paths.some((path) => within(style, preview.path, path))) setPreview(null);
  }
  async function act(change: () => Promise<unknown>, around: string[]) {
    try {
      await change();
      setMessage(null);
    } catch (error) {
      setMessage((error as Error).message);
    }
    reloadAround(around);
  }
  async function upload(directory: string) {
    const paths = await window.desktop!.chooseFiles();
    if (paths.length) await copy({ place: 'local', paths }, { place, dir: directory });
  }
  async function download(paths: string[]) {
    const folder = await api().chooseFolder();
    if (folder) await copy({ place: place.id, paths }, { place: places[0]!, dir: folder });
  }
  function dropped(event: DragEvent, directory: string) {
    event.preventDefault();
    event.stopPropagation();
    const paths = [...event.dataTransfer.files]
      .map((file) => window.desktop!.pathForFile(file))
      .filter(Boolean);
    if (paths.length) void copy({ place: 'local', paths }, { place, dir: directory });
  }

  function entryMenu(event: ReactMouseEvent, path: string, directory: boolean) {
    event.preventDefault();
    event.stopPropagation();
    const into = directory ? path : parentOf(style, path);
    const local = place.kind === 'local';
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        ...(directory
          ? []
          : [{ label: t('files:preview'), icon: <Expand />, run: () => void show(path) }]),
        ...(local
          ? [
              {
                label: t('files:openEditor'),
                icon: <SquareArrowOutUpRight />,
                run: () => void window.desktop!.actOnPath(directory ? 'open' : 'editor', path),
              },
              {
                label: t('files:reveal'),
                icon: <FolderSearch />,
                run: () => void window.desktop!.actOnPath('reveal', path),
              },
            ]
          : [{ label: t('files:download'), icon: <Download />, run: () => void download([path]) }]),
        {
          label: t('files:copy'),
          icon: <Copy />,
          separated: true,
          run: () => setClipboard({ place: place.id, paths: [path] }),
        },
        ...(clipboard && directory
          ? [
              {
                label: t('files:paste'),
                icon: <ClipboardPaste />,
                run: () => void copy(clipboard, { place, dir: into }),
              },
            ]
          : []),
        { label: t('files:copyPath'), icon: <Copy />, run: () => void copyText(path) },
        {
          label: t('files:upload'),
          icon: <Upload />,
          separated: true,
          run: () => void upload(into),
        },
        { label: t('files:newFolder'), icon: <FolderPlus />, run: () => void makeFolder(into) },
        {
          label: t('files:rename'),
          icon: <Pencil />,
          separated: true,
          run: () => void renameEntry(path),
        },
        {
          label: t('files:delete.title'),
          icon: <Trash2 />,
          danger: true,
          run: () => void removeEntries([path]),
        },
      ],
    });
  }
  function blankMenu(event: ReactMouseEvent, directory: string) {
    event.preventDefault();
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        ...(clipboard
          ? [
              {
                label: t('files:paste'),
                icon: <ClipboardPaste />,
                run: () => void copy(clipboard, { place, dir: directory }),
              },
            ]
          : []),
        { label: t('files:upload'), icon: <Upload />, run: () => void upload(directory) },
        {
          label: t('files:newFolder'),
          icon: <FolderPlus />,
          run: () => void makeFolder(directory),
        },
        { label: t('files:refresh'), icon: <RefreshCw />, run: refresh },
      ],
    });
  }

  const changed = useMemo(() => {
    if (!changes || !project) return new Map<string, string>();
    return new Map(
      changes.map((change) => [
        joinPath(
          style,
          project,
          change.path.replaceAll('/', style === 'windows' ? '\\' : '/').replace(/[\\/]$/, ''),
        ),
        change.status,
      ]),
    );
  }, [changes, project, style]);
  const data = useMemo(() => {
    const build = (directory: string): Node[] =>
      sorted(folders[directory]?.entries ?? []).map((entry) => {
        const id = joinPath(style, directory, entry.name);
        return isDirectory(entry)
          ? { id, name: entry.name, entry, children: build(id) }
          : { id, name: entry.name, entry };
      });
    return root ? build(root) : [];
  }, [folders, root, style]);

  function Row({ node, style: position }: NodeRendererProps<Node>) {
    const directory = isDirectory(node.data.entry);
    const status = changed.get(node.id);
    const folder = folders[node.id];
    return (
      <div
        style={position}
        className={`file-row ${node.id === selected ? 'selected' : ''} ${node.isFocused ? 'focused' : ''}`}
        role="treeitem"
        aria-expanded={directory ? node.isOpen : undefined}
        aria-selected={node.id === selected}
        draggable={place.kind === 'local' && !directory}
        title={node.id}
        onDragStart={(event) => {
          event.preventDefault();
          api().drag(node.id);
        }}
        onDragOver={(event) => {
          if (directory && event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDrop={(event) => directory && dropped(event, node.id)}
        onClick={() => {
          if (directory) {
            node.toggle();
            setCurrent(node.id);
          } else void show(node.id);
        }}
        onContextMenu={(event) => entryMenu(event, node.id, directory)}
      >
        {directory ? (
          node.isOpen ? (
            <ChevronDown className="file-chevron" />
          ) : (
            <ChevronRight className="file-chevron" />
          )
        ) : (
          <span className="file-chevron" />
        )}
        {iconOf(node.data.name, directory, node.isOpen)}
        <span className="file-name">{node.data.name}</span>
        {directory && aliasMark(node.data.name)}
        {directory && node.isOpen && folder?.error && (
          <small className="file-error">{folder.error}</small>
        )}
        {status && (
          <span className={`file-status status-${status === '?' ? 'new' : status}`}>
            {status === '?' ? 'U' : status}
          </span>
        )}
      </div>
    );
  }

  const treeBox = useRef<HTMLDivElement>(null);
  const [treeHeight, setTreeHeight] = useState(300);
  useEffect(() => {
    const box = treeBox.current;
    if (!box) return;
    const observer = new ResizeObserver(() => setTreeHeight(box.clientHeight));
    observer.observe(box);
    return () => observer.disconnect();
  });

  const crumbList = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const list = crumbList.current;
    if (list) list.scrollLeft = list.scrollWidth;
  }, [root, layout]);
  const rootFolder = root ? folders[root] : undefined;
  const narrow = layout === 'narrow';
  const previewing = narrow && preview;
  // The service's image is older than the file panel: it has no SFTP server.
  const outdated = place.kind === 'server' && !!info && !info.server;
  const unprotected =
    place.kind === 'server' && info && info.server && !info.protected && !noticeClosed;

  const tree = (
    <div className="file-tree-pane">
      <label className="file-filter">
        <input
          placeholder={t('files:filterHint')}
          aria-label={t('files:filter')}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </label>
      {changes && changes.length > 0 && project && root && within(style, root, project) && (
        <details className="file-changes" open>
          <summary>
            {t('files:changes')} <span>{changes.length}</span>
          </summary>
          <div>
            {changes.slice(0, 200).map((change) => {
              const path = joinPath(
                style,
                project,
                change.path.replaceAll('/', style === 'windows' ? '\\' : '/'),
              );
              return (
                <button
                  type="button"
                  key={change.path}
                  className={`file-row change ${path === selected ? 'selected' : ''}`}
                  title={change.path}
                  onClick={() => !change.path.endsWith('/') && void show(path)}
                  onContextMenu={(event) => entryMenu(event, path, change.path.endsWith('/'))}
                >
                  {iconOf(change.path, change.path.endsWith('/'))}
                  <span className="file-name">{baseName('posix', change.path)}</span>
                  <span className="file-dir">{change.path.split('/').slice(0, -1).join('/')}</span>
                  <span
                    className={`file-status status-${change.status === '?' ? 'new' : change.status}`}
                  >
                    {change.status === '?' ? 'U' : change.status}
                  </span>
                </button>
              );
            })}
          </div>
        </details>
      )}
      <div
        className="file-tree"
        ref={treeBox}
        onContextMenu={(event) => root && blankMenu(event, root)}
        onDragOver={(event) => event.dataTransfer.types.includes('Files') && event.preventDefault()}
        onDrop={(event) => root && dropped(event, root)}
      >
        {rootFolder?.error ? (
          <p className="file-empty-note">{rootFolder.error}</p>
        ) : !rootFolder ? (
          <p className="file-empty-note">{t('files:reading')}</p>
        ) : !data.length ? (
          <p className="file-empty-note">{t('files:empty')}</p>
        ) : (
          <Tree<Node>
            data={data}
            width="100%"
            height={treeHeight}
            rowHeight={28}
            indent={14}
            openByDefault={false}
            disableDrag
            disableDrop
            disableEdit
            disableMultiSelection
            searchTerm={filter}
            searchMatch={(node, term) =>
              `${node.data.name} ${alias(node.data.name) ?? ''}`
                .toLowerCase()
                .includes(term.toLowerCase())
            }
            onToggle={(id) => {
              if (!folders[id]) void load(id);
            }}
          >
            {Row}
          </Tree>
        )}
      </div>
    </div>
  );

  const listFolder = current && folders[current]?.entries ? current : root;
  const list = layout === 'page' && listFolder && (
    <div
      className="file-list"
      onContextMenu={(event) => blankMenu(event, listFolder)}
      onDragOver={(event) => event.dataTransfer.types.includes('Files') && event.preventDefault()}
      onDrop={(event) => dropped(event, listFolder)}
    >
      <div className="file-list-caption" title={listFolder}>
        <FolderOpen />
        <span className="file-name">{baseName(style, listFolder)}</span>
        {aliasMark(baseName(style, listFolder))}
      </div>
      <table>
        <thead>
          <tr>
            <th>{t('files:col.name')}</th>
            <th>{t('files:col.size')}</th>
            <th>{t('files:col.modified')}</th>
          </tr>
        </thead>
        <tbody>
          {sorted(folders[listFolder]?.entries ?? []).map((entry) => {
            const path = joinPath(style, listFolder, entry.name);
            const directory = isDirectory(entry);
            return (
              <tr
                key={entry.name}
                className={path === selected ? 'selected' : ''}
                onClick={() =>
                  directory ? (setCurrent(path), folders[path] || void load(path)) : void show(path)
                }
                onContextMenu={(event) => entryMenu(event, path, directory)}
              >
                <td>
                  <div>
                    {iconOf(entry.name, directory)}
                    <span>{entry.name}</span>
                    {directory && aliasMark(entry.name)}
                  </div>
                </td>
                <td>{directory ? '' : formatSize(entry.size)}</td>
                <td>{formatTime(entry.mtime)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const previewPane = preview ? (
    <section className="file-preview" aria-label={t('files:previewLabel')}>
      <header className="file-preview-head">
        {narrow && (
          <IconButton title={t('files:backToFolder')} onClick={() => setPreview(null)}>
            <ArrowLeft />
          </IconButton>
        )}
        {iconOf(baseName(style, preview.path))}
        <b title={preview.path}>{baseName(style, preview.path)}</b>
        <span className="file-meta">
          {preview.size ? formatSize(preview.size) : ''}
          {changed.get(preview.path) ? ` · ${t('files:changed')}` : ''}
        </span>
        <span className="grow" />
        {preview.shown?.kind === 'markdown' && (
          <button
            type="button"
            className="file-source-toggle"
            onClick={() => setPreview({ ...preview, source: !preview.source })}
          >
            {preview.source ? t('files:rendered') : t('files:source')}
          </button>
        )}
        {place.kind === 'local' ? (
          <IconButton
            title={t('files:openEditor')}
            onClick={() => void window.desktop!.actOnPath('editor', preview.path)}
          >
            <SquareArrowOutUpRight />
          </IconButton>
        ) : (
          <IconButton title={t('files:downloadHere')} onClick={() => void download([preview.path])}>
            <Download />
          </IconButton>
        )}
        {preview.shown && preview.shown.kind !== 'binary' && (
          <IconButton title={t('files:readFull')} onClick={() => setReading(true)}>
            <Maximize2 />
          </IconButton>
        )}
      </header>
      {preview.truncated && preview.shown?.kind !== 'image' && (
        <p className="file-truncated">{t('files:truncated')}</p>
      )}
      <div className="file-preview-body">{previewBody(preview)}</div>
    </section>
  ) : layout !== 'narrow' ? (
    <section className="file-preview empty" aria-label={t('files:previewLabel')}>
      <FolderOpen />
      <span>{t('files:choosePreview')}</span>
    </section>
  ) : null;

  function previewBody(shown: NonNullable<typeof preview>): ReactNode {
    if (shown.error) return <p className="file-empty-note">{shown.error}</p>;
    if (!shown.shown) return <p className="file-empty-note">{t('files:reading')}</p>;
    const content = shown.shown;
    if (content.kind === 'image')
      return <img className="file-image" src={content.url} alt={baseName(style, shown.path)} />;
    if (content.kind === 'binary') return <p className="file-empty-note">{t('files:noPreview')}</p>;
    if (content.kind === 'markdown' && !shown.source)
      return (
        <div className="file-markdown message-content">
          <RichText text={content.text} />
        </div>
      );
    const lines = content.text.split('\n');
    return (
      <pre className="file-code">
        {lines.slice(0, SHOWN_LINES).map((line, index) => (
          <div key={index}>
            <span className="line-number">{index + 1}</span>
            {line || ' '}
          </div>
        ))}
        {lines.length > SHOWN_LINES && (
          <div className="file-more">
            {t('files:moreLines', { count: lines.length - SHOWN_LINES })}
          </div>
        )}
      </pre>
    );
  }

  const placesBar =
    places.length === 1 ? (
      <span className="file-place-only">
        {placeIcon(place)}
        {place.label}
      </span>
    ) : !narrow ? (
      <div className="file-places" role="tablist" aria-label={t('files:place.label')}>
        {places.map((entry) => (
          <button
            type="button"
            role="tab"
            key={entry.id}
            aria-selected={entry.id === place.id}
            className={entry.id === place.id ? 'active' : ''}
            onClick={() => setPlaceId(entry.id)}
          >
            {placeIcon(entry)}
            <span>{entry.label}</span>
          </button>
        ))}
      </div>
    ) : (
      <label className="file-place-select">
        {placeIcon(place)}
        <select
          aria-label={t('files:place.label')}
          value={place.id}
          onChange={(event) => setPlaceId(event.target.value)}
        >
          {places.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
    );

  return (
    <div className={`file-panel layout-${layout}`}>
      <header className="file-panel-head">
        {placesBar}
        <span className="grow" />
        <HelpLink article="files" title={t('files:help')} />
        <IconButton
          title={t('files:uploadFiles')}
          disabled={!root}
          onClick={() => root && void upload(current ?? root)}
        >
          <Upload />
        </IconButton>
        <IconButton
          title={t('files:newFolder')}
          disabled={!root}
          onClick={() => root && void makeFolder(current ?? root)}
        >
          <FolderPlus />
        </IconButton>
        <IconButton title={t('files:refresh')} onClick={refresh}>
          <RefreshCw />
        </IconButton>
        <IconButton
          title={layout === 'page' ? t('files:toSide') : t('files:toPage')}
          onClick={() => setPage(layout !== 'page')}
        >
          {layout === 'page' ? <Minimize2 /> : <Maximize2 />}
        </IconButton>
        <IconButton title={t('files:close')} onClick={close}>
          <X />
        </IconButton>
      </header>
      {root && (
        <nav className="file-crumbs" aria-label={t('files:current')}>
          <IconButton
            title={t('files:up')}
            disabled={parentOf(style, root) === root}
            onClick={() => void go(parentOf(style, root))}
          >
            <ArrowUp />
          </IconButton>
          <span className="file-crumb-list" ref={crumbList}>
            {crumbs(style, root).map((step, index, all) => (
              <button
                type="button"
                key={step.path}
                className={index === all.length - 1 ? 'current' : ''}
                onClick={() => index < all.length - 1 && void go(step.path)}
              >
                <span>{step.label}</span>
                {aliasMark(step.label)}
              </button>
            ))}
          </span>
        </nav>
      )}
      {unprotected && (
        <div className="file-notice" role="note">
          <ShieldAlert />
          <span title={t('files:landlock.detail')}>{t('files:landlock.title')}</span>
          <IconButton
            title={t('files:landlock.dismiss')}
            onClick={() => {
              localStorage.setItem(`files-notice:${noticeKey}`, 'closed');
              setNoticeClosed(true);
            }}
          >
            <X />
          </IconButton>
        </div>
      )}
      {message && (
        <div className="file-message" role="alert">
          <span>{message}</span>
          <IconButton title={t('files:closeNotice')} onClick={() => setMessage(null)}>
            <X />
          </IconButton>
        </div>
      )}
      <div className="file-panel-body">
        {outdated ? (
          <div className="file-preview empty file-outdated" role="note">
            <ServerOff />
            <b>{t('files:oldImage.title')}</b>
            <span title={t('files:oldImage.detail')}>{t('files:oldImage.action')}</span>
          </div>
        ) : previewing ? (
          previewPane
        ) : (
          <>
            {tree}
            {list}
            {!narrow && previewPane}
          </>
        )}
      </div>
      {transfers.length > 0 && (
        <ul className="file-transfers" aria-label={t('files:transfer.list')}>
          {transfers.map((transfer) => (
            <li key={transfer.id} className={`transfer-${transfer.state}`}>
              {transfer.request.to.target === 'local' ? <Download /> : <Upload />}
              <span className="transfer-label" title={transfer.error ?? transfer.label}>
                {transfer.state === 'failed'
                  ? t('files:transfer.failedWith', {
                      label: transfer.label,
                      error: transfer.error ?? '',
                    })
                  : transfer.label}
              </span>
              {transfer.state === 'running' && (
                <span className="transfer-bar">
                  <i
                    style={{
                      width: `${transfer.total ? (transfer.done / transfer.total) * 100 : 0}%`,
                    }}
                  />
                </span>
              )}
              <span className="transfer-state">
                {transfer.state === 'running'
                  ? transfer.total
                    ? `${formatSize(transfer.done)} / ${formatSize(transfer.total)}`
                    : t('files:transfer.preparing')
                  : transfer.state === 'done'
                    ? t('files:transfer.done')
                    : transfer.state === 'cancelled'
                      ? t('files:transfer.cancelled')
                      : t('files:transfer.failed')}
              </span>
              {transfer.state === 'running' ? (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => void api().cancel(transfer.id)}
                >
                  {t('common:cancel')}
                </button>
              ) : transfer.state === 'failed' ? (
                <>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      setTransfers((all) => all.filter((entry) => entry.id !== transfer.id));
                      run({
                        label: transfer.label,
                        request: { ...transfer.request, conflict: 'resume' },
                      });
                    }}
                  >
                    {t('files:transfer.resume')}
                  </button>
                  <IconButton
                    title={t('files:transfer.remove')}
                    onClick={() =>
                      setTransfers((all) => all.filter((entry) => entry.id !== transfer.id))
                    }
                  >
                    <X />
                  </IconButton>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {menu && <Menu label={t('files:title')} {...menu} onClose={() => setMenu(null)} />}
      {reading && preview?.shown && preview.shown.kind !== 'binary' && (
        <Modal title={baseName(style, preview.path)} onClose={() => setReading(false)}>
          <div className="file-reader">{previewBody(preview)}</div>
        </Modal>
      )}
      {ask?.kind === 'name' && <NameDialog ask={ask} />}
      {ask?.kind === 'confirm' && (
        <Modal title={ask.title} onClose={() => ask.resolve(false)}>
          <p className="delete-question">{ask.text}</p>
          <div className="dialog-actions">
            <button type="button" className="button secondary" onClick={() => ask.resolve(false)}>
              {t('common:cancel')}
            </button>
            <button type="button" className="button danger" onClick={() => ask.resolve(true)}>
              {t('files:delete.confirm')}
            </button>
          </div>
        </Modal>
      )}
      {ask?.kind === 'conflict' && (
        <Modal title={t('files:conflict.title')} onClose={() => ask.resolve(null)}>
          <p className="delete-question">
            {ask.names.length === 1
              ? t('files:conflict.one', { name: ask.names[0] })
              : t('files:conflict.many', {
                  names: ask.names.slice(0, 3),
                  count: ask.names.length,
                })}
          </p>
          <div className="dialog-actions">
            <button type="button" className="button secondary" onClick={() => ask.resolve(null)}>
              {t('common:cancel')}
            </button>
            <button type="button" className="button secondary" onClick={() => ask.resolve('skip')}>
              {t('files:conflict.skip')}
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => ask.resolve('resume')}
            >
              {t('files:transfer.resume')}
            </button>
            <button type="button" className="button primary" onClick={() => ask.resolve('replace')}>
              {t('files:conflict.replace')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function NameDialog({ ask }: { ask: Extract<Ask, { kind: 'name' }> }) {
  const t = useT();
  const [value, setValue] = useState(ask.value);
  const valid = value.trim() && !/[\\/]/.test(value);
  return (
    <Modal title={ask.title} onClose={() => ask.resolve(null)}>
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) ask.resolve(value.trim());
        }}
      >
        <label>
          {t('files:col.name')}
          <input
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onFocus={(event) => {
              const dot = event.target.value.lastIndexOf('.');
              event.target.setSelectionRange(0, dot > 0 ? dot : event.target.value.length);
            }}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={() => ask.resolve(null)}>
            {t('common:cancel')}
          </button>
          <button type="submit" className="button primary" disabled={!valid}>
            {t('files:ok')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
