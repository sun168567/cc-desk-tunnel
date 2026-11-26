import type { T } from './i18n.ts';
export type ToolPicture = { type: string; data: string };

// A tool that looked at a picture (Read on an image, a screenshot an MCP tool took) answers with content blocks,
// which the service passes on as their JSON. The pictures are shown as pictures and the words stay text; any
// other output is left as it is.
export function toolPictures(output: string) {
  if (!output.startsWith('[') || !output.includes('"image"')) return null;
  let blocks: unknown;
  try {
    blocks = JSON.parse(output);
  } catch {
    return null;
  }
  if (!Array.isArray(blocks)) return null;
  const text: string[] = [];
  const pictures: ToolPicture[] = [];
  for (const block of blocks as {
    type?: unknown;
    text?: unknown;
    source?: { type?: unknown; media_type?: unknown; data?: unknown };
  }[]) {
    const source = block?.source;
    if (block?.type === 'text' && typeof block.text === 'string') text.push(block.text);
    else if (
      block?.type === 'image' &&
      source?.type === 'base64' &&
      typeof source.media_type === 'string' &&
      /^image\/(?:png|jpeg|gif|webp)$/.test(source.media_type) &&
      typeof source.data === 'string'
    )
      pictures.push({ type: source.media_type, data: source.data });
    else return null;
  }
  return pictures.length ? { text: text.join('\n'), pictures } : null;
}
export const pictureUrl = (picture: ToolPicture) => `data:${picture.type};base64,${picture.data}`;
// What stands for a picture in text: its type and about how large it is.
export const pictureNote = (t: T, picture: ToolPicture) =>
  t('session:picture.note', {
    type: picture.type,
    size: Math.max(1, Math.round((picture.data.length * 3) / 4 / 1024)),
  });
