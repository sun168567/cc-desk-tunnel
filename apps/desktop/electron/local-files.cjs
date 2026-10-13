const path = require('node:path');
const { open, readdir, realpath } = require('node:fs/promises');
const images = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new Error('文件路径无效。');
  return path.resolve(value);
}
async function previewFile(value) {
  const target = absolute(value);
  const file = await open(target, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('不是普通文件。');
    const mime = images[path.extname(target).toLowerCase()];
    if (mime && info.size > 8 * 1024 * 1024) return { kind: 'unavailable', reason: '图片超过 8 MB' };
    const size = Math.min(info.size, mime ? 8 * 1024 * 1024 : 32 * 1024);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read(buffer, 0, size, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (mime) return { kind: 'image', data: `data:${mime};base64,${bytes.toString('base64')}` };
    if (bytes.includes(0)) return { kind: 'unavailable', reason: '无法预览' };
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      return { kind: 'text', text: decoder.decode(bytes, { stream: info.size > size }), truncated: info.size > size };
    } catch { return { kind: 'unavailable', reason: '无法预览' }; }
  } finally { await file.close(); }
}
const skipDirs = new Set(['.git', 'node_modules', 'dist', '.next']);
const walkCap = 20000;
const listCacheMs = 30_000;
const listings = new Map();

async function walkFiles(root) {
  const files = [];
  const pending = [{ dir: root, depth: 0 }];
  let cursor = 0;
  let seen = 0;
  while (cursor < pending.length && seen < walkCap) {
    const { dir, depth } = pending[cursor++];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (++seen > walkCap) break;
      if (entry.isSymbolicLink()) continue;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 8 && !skipDirs.has(entry.name)) pending.push({ dir: target, depth: depth + 1 });
      } else if (entry.isFile()) {
        files.push({ path: target, name: entry.name, rel: path.relative(root, target), depth });
      }
    }
  }
  return files;
}

function filesUnder(root) {
  const hit = listings.get(root);
  if (hit?.files && Date.now() - hit.at < listCacheMs) return Promise.resolve(hit.files);
  if (hit?.pending) return hit.files ? Promise.resolve(hit.files) : hit.pending;
  const pending = walkFiles(root).then(
    (files) => {
      listings.set(root, { at: Date.now(), files });
      return files;
    },
    () => {
      const current = listings.get(root);
      if (current?.files) {
        listings.set(root, { at: Date.now(), files: current.files });
        return current.files;
      }
      listings.delete(root);
      return [];
    },
  );
  listings.set(root, { at: hit?.at ?? 0, files: hit?.files, pending });
  if (listings.size > 4) {
    for (const key of listings.keys()) {
      if (key !== root) {
        listings.delete(key);
        break;
      }
    }
  }
  return hit?.files ? Promise.resolve(hit.files) : pending;
}

// Filename matches outrank path matches. An empty query lists only the project root.
function rankFiles(files, query) {
  const needle = String(query).trim().toLowerCase();
  const scored = [];
  for (const file of files) {
    const name = file.name.toLowerCase();
    const rel = file.rel.toLowerCase();
    let score = 0;
    if (!needle) score = file.depth === 0 ? 1 : 0;
    else if (name === needle) score = 400;
    else if (name.startsWith(needle)) score = 300;
    else if (name.includes(needle)) score = 200;
    else if (rel.includes(needle)) score = 100;
    if (score) scored.push({ file, score });
  }
  scored.sort(
    (a, b) => b.score - a.score || a.file.rel.length - b.file.rel.length || a.file.rel.localeCompare(b.file.rel),
  );
  return scored.slice(0, 20).map((item) => item.file.path);
}

async function searchFiles(directory, query) {
  const root = await realpath(absolute(directory));
  if (typeof query !== 'string' || query.length > 200) throw new Error('筛选文字无效。');
  return rankFiles(await filesUnder(root), query);
}
const textCap = 1024 * 1024;
async function readTextFile(value) {
  const target = absolute(value);
  const file = await open(target, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('不是普通文件。');
    const size = Math.min(info.size, textCap);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read(buffer, 0, size, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) throw new Error('不是文本文件。');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return { text: decoder.decode(bytes), truncated: info.size > textCap };
  } finally {
    await file.close();
  }
}
module.exports = { previewFile, searchFiles, readTextFile, rankFiles };
