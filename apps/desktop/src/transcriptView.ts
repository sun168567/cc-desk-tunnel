// How much of the work behind a reply the conversation shows. `standard` is how it has always looked: while a turn
// runs its steps are in groups, folded; once it ends they fold into one line, "用时 …". `expanded` lays every call
// and thought out one after another, folds nothing, and shows the first line of each folded thought.
export type ViewMode = 'standard' | 'expanded';
export type TranscriptView = { mode: ViewMode };

export const defaultView: TranscriptView = { mode: 'standard' };

// Each is named and told about by settings:view.<mode>.
export const viewModes: ViewMode[] = ['standard', 'expanded'];

// The first line that says something, without the Markdown around it. Only a list marker is taken off the start, so
// a line that begins with a number keeps it.
export function firstLine(text: string) {
  for (const line of text.split('\n')) {
    const plain = line
      .replace(/^\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?/, '')
      .replace(/\*\*|__|`/g, '')
      .trim();
    if (plain) return plain;
  }
  return '';
}
