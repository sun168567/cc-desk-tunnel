import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { INSTRUCTIONS_LIMIT } from '@cc-desk-tunnel/protocol';
import { DomainError } from './errors.ts';

// The official CLI's user instructions, CLAUDE.md in its configuration directory, which every session on this service
// loads when its CLI starts. Claude Code reads no AGENTS.md at this level, only in a project.
export function instructionsPath(configDirectory = process.env.CLAUDE_CONFIG_DIR) {
  return join(configDirectory ?? join(homedir(), '.claude'), 'CLAUDE.md');
}

// The text, and a version that tells whether the file has changed since it was read.
export function readInstructions(path = instructionsPath()) {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (text.length > INSTRUCTIONS_LIMIT)
    throw new DomainError(
      'instructions_too_long',
      `全局说明超过 ${INSTRUCTIONS_LIMIT} 字，请在 ccdt 里用 /memory 编辑。`,
    );
  return { text, version: createHash('sha256').update(text).digest('hex') };
}

// Written only over the version the editor read, so a change made meanwhile elsewhere is not lost. Emptied, the file
// is removed, as if it had never been written.
export function writeInstructions(text: string, version: string, path = instructionsPath()) {
  if (readInstructions(path).version !== version)
    throw new DomainError('instructions_changed', '全局说明已在别处修改，请重新载入后再改。');
  if (!text.trim()) rmSync(path, { force: true });
  else {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(`${path}.proxy`, text, { mode: 0o600 });
    renameSync(`${path}.proxy`, path);
  }
  return readInstructions(path);
}
