import { createContext } from 'react';

// Agenerated document the conversation can open in the side drawer. `fallback` is the text the tool
// wrote, used until the file on disk can be read.
export type DocumentPreview = { path: string; fallback: string };
export const OpenDocument = createContext<(document: DocumentPreview) => void>(() => {});
export type FileLookupContext = {
  projectPath: string;
  knownPaths: ReadonlyMap<string, string>;
};
export const FileLookup = createContext<FileLookupContext>({
  projectPath: '',
  knownPaths: new Map(),
});

const images = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const sourceDocs = new Set(['xml', 'svg', 'txt']);

function extensionOf(filePath: string) {
  const base = filePath.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

// Generated Markdown and HTML open in the side pane. XML, SVG, and plain text open there as source.
export function documentKind(filePath: string): 'markdown' | 'html' | 'source' | null {
  const extension = extensionOf(filePath);
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (extension === 'html' || extension === 'htm') return 'html';
  if (sourceDocs.has(extension)) return 'source';
  return null;
}

// An uploaded file other than a picture opens in that same pane. Pictures stay on the card.
export function paneKind(filePath: string): 'markdown' | 'html' | 'source' | null {
  const extension = extensionOf(filePath);
  if (extension && images.has(extension)) return null;
  return documentKind(filePath) ?? 'source';
}
