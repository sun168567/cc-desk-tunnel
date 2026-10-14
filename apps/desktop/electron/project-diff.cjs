const { spawn } = require('node:child_process');
const { open, readdir, stat } = require('node:fs/promises');
const path = require('node:path');

// A turn's file preview is the difference on disk between the moment the message is sent and the moment its
// commands have finished. Git status names the files worth reading; a folder that is not a repository is
// walked once for modification times, skipping dependency directories. Nothing here is parsed out of a script.

const FILE_CAP = 1024 * 1024;
const TOTAL_CAP = 32 * 1024 * 1024;
const WALK_CAP = 8000;
const RESULT_CAP = 40;
const skipDirs = new Set(['.git', 'node_modules', 'dist', '.next', 'coverage', '.cache']);

const baselines = new Map();
const results = new Map();
const pending = new Map();

function normalize(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function inside(directory, file) {
  const rel = path.relative(directory, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// An untracked directory is walked only when it is the project or sits inside it. A parent folder of the
// project would pull in the rest of that tree.
function covers(directory, dir) {
  return path.resolve(directory) === path.resolve(dir) || inside(directory, dir);
}

function abs(root, rel) {
  const parts = rel.split(/[/\\]/).filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) return null;
  return path.resolve(root, ...parts);
}

function git(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' },
    });
    const out = [];
    let total = 0;
    let overflow = false;
    const timer = setTimeout(() => child.kill(), 8000);
    child.stdout.on('data', (chunk) => {
      total += chunk.length;
      if (total > 8 * 1024 * 1024) {
        overflow = true;
        child.kill();
      } else out.push(chunk);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: Buffer.alloc(0), overflow: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: overflow ? 1 : (code ?? 1), stdout: Buffer.concat(out), overflow });
    });
  });
}

// Porcelain v1 with -z: `XY PATH\0`, and for a rename `XY ORIG\0PATH\0`.
function parseStatus(buffer) {
  const entries = [];
  let at = 0;
  while (at + 4 <= buffer.length) {
    const code = buffer.toString('utf8', at, at + 2);
    let end = buffer.indexOf(0, at + 3);
    if (end < 0) break;
    const first = buffer.toString('utf8', at + 3, end);
    at = end + 1;
    let file = first;
    let from = null;
    if (code.includes('R') || code.includes('C')) {
      end = buffer.indexOf(0, at);
      if (end < 0) break;
      from = first;
      file = buffer.toString('utf8', at, end);
      at = end + 1;
    }
    entries.push({ code, path: file, from });
  }
  return entries;
}

async function readText(file) {
  let info;
  try {
    info = await stat(file);
  } catch {
    return { missing: true, text: '' };
  }
  if (!info.isFile()) return { missing: true, text: '' };
  if (info.size > FILE_CAP) return { tooBig: true, size: info.size, mtimeMs: info.mtimeMs };
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(info.size);
    await handle.read(buffer, 0, info.size, 0);
    if (buffer.includes(0)) return { binary: true, size: info.size, mtimeMs: info.mtimeMs };
    return { text: buffer.toString('utf8'), size: info.size, mtimeMs: info.mtimeMs };
  } finally {
    await handle.close();
  }
}

async function walk(directory, visit) {
  const pendingDirs = [directory];
  let seen = 0;
  while (pendingDirs.length && seen < WALK_CAP) {
    const dir = pendingDirs.pop();
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (seen >= WALK_CAP) return;
      if (entry.isSymbolicLink()) continue;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) pendingDirs.push(target);
      } else if (entry.isFile()) {
        seen++;
        await visit(target);
      }
    }
  }
}

async function showFile(root, head, file) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  const spec = `${head}:${rel}`;
  const size = await git(root, ['cat-file', '-s', spec]);
  if (size.code !== 0) return { text: '' };
  const bytes = Number(size.stdout.toString('utf8').trim());
  if (!Number.isFinite(bytes) || bytes > FILE_CAP) return { tooBig: true };
  const blob = await git(root, ['cat-file', 'blob', spec]);
  if (blob.code !== 0) return { text: '' };
  if (blob.stdout.includes(0)) return { binary: true };
  return { text: blob.stdout.toString('utf8') };
}

function remember(files, file, value, budget) {
  if (files.has(file)) return budget;
  if (value.text == null) {
    files.set(file, value);
    return budget;
  }
  const text = value.text;
  if (text.length > budget) files.set(file, { ...value, text: null });
  else {
    files.set(file, value);
    budget -= text.length;
  }
  return budget;
}

async function snapshotFile(files, file, budget) {
  if (!file || files.has(file)) return budget;
  const read = await readText(file);
  if (read.binary || read.tooBig) return remember(files, file, { text: null, ...read }, budget);
  return remember(files, file, { text: read.text, size: read.size, mtimeMs: read.mtimeMs }, budget);
}

async function toplevel(directory) {
  const result = await git(directory, ['rev-parse', '--show-toplevel']);
  if (result.code !== 0) return null;
  const root = result.stdout.toString('utf8').trim();
  return root ? path.resolve(root) : null;
}

async function captureGit(directory, root) {
  const headResult = await git(root, ['rev-parse', 'HEAD']);
  const head = headResult.code === 0 ? headResult.stdout.toString('utf8').trim() : null;
  const status = parseStatus((await git(root, ['status', '--porcelain=v1', '-z'])).stdout);
  const files = new Map();
  let budget = TOTAL_CAP;
  const take = async (rel) => {
    if (!rel || rel.endsWith('/')) return;
    const file = abs(root, rel);
    if (!file || !inside(directory, file)) return;
    budget = await snapshotFile(files, file, budget);
  };
  for (const entry of status) {
    if (entry.from) await take(entry.from);
    if (entry.path.endsWith('/')) {
      const dir = abs(root, entry.path.slice(0, -1));
      if (!dir || skipDirs.has(path.basename(dir)) || !covers(directory, dir)) continue;
      await walk(dir, async (file) => {
        if (inside(directory, file)) budget = await snapshotFile(files, file, budget);
      });
    } else await take(entry.path);
  }
  return { directory, git: { root, head }, files };
}

async function captureWalk(directory) {
  const files = new Map();
  let budget = TOTAL_CAP;
  await walk(directory, async (file) => {
    budget = await snapshotFile(files, file, budget);
  });
  return { directory, git: null, files };
}

function pushChange(changes, file, oldText, newText) {
  if (changes.length >= RESULT_CAP || oldText == null || newText == null) return;
  const before = normalize(oldText);
  const after = normalize(newText);
  if (before === after) return;
  changes.push({ path: file, oldText: before, newText: after });
}

async function finishGit(baseline) {
  const { root, head } = baseline.git;
  const endHeadResult = await git(root, ['rev-parse', 'HEAD']);
  const endHead = endHeadResult.code === 0 ? endHeadResult.stdout.toString('utf8').trim() : null;
  const status = parseStatus((await git(root, ['status', '--porcelain=v1', '-z'])).stdout);
  const paths = new Set(baseline.files.keys());
  const addRel = async (rel) => {
    if (!rel) return;
    if (rel.endsWith('/')) {
      const dir = abs(root, rel.slice(0, -1));
      if (!dir || skipDirs.has(path.basename(dir)) || !covers(baseline.directory, dir)) return;
      await walk(dir, (file) => {
        if (inside(baseline.directory, file)) paths.add(file);
      });
      return;
    }
    const file = abs(root, rel);
    if (file && inside(baseline.directory, file)) paths.add(file);
  };
  for (const entry of status) {
    if (entry.from) await addRel(entry.from);
    await addRel(entry.path);
  }
  if (head && endHead && head !== endHead) {
    const names = await git(root, ['diff', '--name-only', '-z', head, endHead]);
    if (names.code === 0)
      for (const rel of names.stdout.toString('utf8').split('\0')) await addRel(rel);
  }
  const changes = [];
  for (const file of [...paths].sort()) {
    if (!inside(baseline.directory, file)) continue;
    let oldText;
    if (baseline.files.has(file)) oldText = baseline.files.get(file).text;
    else if (head) {
      const shown = await showFile(root, head, file);
      if (shown.binary || shown.tooBig) continue;
      oldText = shown.text;
    } else oldText = '';
    const current = await readText(file);
    if (current.binary || current.tooBig) continue;
    pushChange(changes, file, oldText, current.text);
  }
  return changes;
}

async function finishWalk(baseline) {
  const now = new Map();
  await walk(baseline.directory, async (file) => {
    const info = await stat(file).catch(() => null);
    if (info?.isFile()) now.set(file, { size: info.size, mtimeMs: info.mtimeMs });
  });
  const changes = [];
  const paths = new Set([...baseline.files.keys(), ...now.keys()]);
  for (const file of [...paths].sort()) {
    const before = baseline.files.get(file);
    const after = now.get(file);
    if (before && after && before.mtimeMs === after.mtimeMs && before.size === after.size) continue;
    if (before && before.text == null) continue;
    const current = after ? await readText(file) : { text: '' };
    if (current.binary || current.tooBig) continue;
    pushChange(changes, file, before ? before.text : '', current.text);
  }
  return changes;
}

function prune() {
  while (results.size > 12) results.delete(results.keys().next().value);
  if (baselines.size <= 30) return;
  const oldest = [...baselines.entries()].sort((a, b) => a[1].at - b[1].at);
  while (baselines.size > 30) baselines.delete(oldest.shift()[0]);
}

async function beginProjectDiff(id, directory) {
  if (typeof id !== 'string' || !id || id.length > 80) throw new Error('无效的记录');
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0'))
    throw new Error('文件路径无效。');
  const root = path.resolve(directory);
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      results.set(id, []);
      return;
    }
    const gitRoot = await toplevel(root);
    const captured = gitRoot ? await captureGit(root, gitRoot) : await captureWalk(root);
    baselines.set(id, { ...captured, at: Date.now() });
    results.delete(id);
    prune();
  } catch {
    baselines.delete(id);
    results.set(id, []);
  }
}

function finishProjectDiff(id) {
  if (typeof id !== 'string') return Promise.resolve(null);
  if (results.has(id)) return Promise.resolve(results.get(id));
  if (pending.has(id)) return pending.get(id);
  if (!baselines.has(id)) return Promise.resolve(null);
  const job = (async () => {
    const baseline = baselines.get(id);
    baselines.delete(id);
    try {
      const files = baseline
        ? baseline.git
          ? await finishGit(baseline)
          : await finishWalk(baseline)
        : [];
      results.set(id, files);
      prune();
      return files;
    } catch {
      results.set(id, []);
      return [];
    }
  })().finally(() => pending.delete(id));
  pending.set(id, job);
  return job;
}

function dropProjectDiff(id) {
  baselines.delete(id);
  results.delete(id);
}

module.exports = {
  beginProjectDiff,
  finishProjectDiff,
  dropProjectDiff,
  parseStatus,
};
