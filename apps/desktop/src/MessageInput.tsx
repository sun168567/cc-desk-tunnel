import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ClipboardEvent, KeyboardEvent } from 'react';
import { fileName, pieces, quote } from './attachments.ts';
import { isPicture, localPicture } from './links.ts';
import { PictureDialog } from './Picture.tsx';

export type MessageInputHandle = {
  focus: () => void;
  // Puts files in where the caret is, each as its quoted path.
  insert: (paths: string[]) => void;
};

type Props = {
  value: string;
  onChange: (text: string) => void;
  // Whether the paths in it are Windows paths, those of the computer the session's project is on.
  windows: boolean;
  disabled: boolean;
  placeholder: string;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  // Sees a paste first; what it takes, it prevents.
  onPaste: (event: ClipboardEvent<HTMLElement>) => void;
};

const limit = 16000;

// A browser can put no files in a message: the box there is plain text.
const PlainInput = forwardRef<MessageInputHandle, Props>(function PlainInput(
  { value, onChange, disabled, placeholder, onKeyDown, onPaste },
  ref,
) {
  const box = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(
    ref,
    () => ({
      focus: () => box.current?.focus(),
      insert(paths) {
        const at = box.current?.selectionStart ?? value.length;
        const before = value.slice(0, at);
        const lead = before && !/\s$/.test(before) ? ' ' : '';
        onChange(`${before}${lead}${paths.map(quote).join(' ')} ${value.slice(at)}`);
        box.current?.focus();
      },
    }),
    [value, onChange],
  );
  useLayoutEffect(() => {
    // Grow with the text; the stylesheet's max-height decides when scrolling takes over.
    if (!box.current) return;
    box.current.style.height = 'auto';
    box.current.style.height = `${box.current.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={box}
      className="message-input"
      aria-label="消息"
      placeholder={placeholder}
      value={value}
      disabled={disabled}
      maxLength={limit}
      rows={2}
      onChange={(event) => onChange(event.target.value)}
      onPaste={onPaste}
      onKeyDown={onKeyDown}
    />
  );
});

// A file in the box: a picture small, any other file by its icon, both by name; the path shows on hover.
function chip(path: string) {
  const element = document.createElement('span');
  element.className = isPicture(path) ? 'path-chip' : 'path-chip file';
  element.contentEditable = 'false';
  element.dataset.path = path;
  element.title = path;
  if (isPicture(path)) {
    const image = document.createElement('img');
    image.src = localPicture(path);
    image.alt = '';
    element.append(image);
  }
  const name = document.createElement('span');
  name.className = 'path-chip-name';
  name.textContent = fileName(path);
  const remove = document.createElement('span');
  remove.className = 'path-chip-remove';
  remove.title = '移除';
  element.append(name, remove);
  return element;
}

// The text drawn into the box: each line break a <br>, and one more after a last line break, which would
// otherwise not show its empty line (see textOf).
function draw(into: HTMLElement, text: string, windows: boolean, whole: boolean) {
  const nodes: Node[] = [];
  for (const piece of pieces(text, windows)) {
    if ('path' in piece) nodes.push(chip(piece.path));
    else
      piece.text.split('\n').forEach((line, index) => {
        if (index) nodes.push(document.createElement('br'));
        if (line) nodes.push(document.createTextNode(line));
      });
  }
  if (whole && text.endsWith('\n')) nodes.push(document.createElement('br'));
  into.replaceChildren(...nodes);
}

// What part of the box stands for: its words, each file as its quoted path, each line break as one. A break that
// ends the box or a block only holds its line open; a block, as typing may make, starts a line.
function textOf(root: Node) {
  let text = '';
  const last = (node: Node) => {
    let next = node.nextSibling;
    while (next?.nodeType === Node.TEXT_NODE && !next.nodeValue) next = next.nextSibling;
    return !next;
  };
  const walk = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) text += child.nodeValue!.replaceAll(' ', ' ');
      else if (!(child instanceof HTMLElement)) continue;
      else if (child.dataset.path !== undefined) text += quote(child.dataset.path);
      else if (child.tagName === 'BR') {
        if (!last(child)) text += '\n';
      } else {
        if (/^(?:DIV|P)$/.test(child.tagName) && text && !text.endsWith('\n')) text += '\n';
        walk(child);
      }
    }
  };
  walk(root);
  return text;
}

function caretAtEnd(box: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(box);
  range.collapse(false);
  const selection = getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

// In the desktop window the files in a message show as files, where they stand in the text, while the text holds
// their paths as before: the box is editable rich text that only ever stands for plain text.
const RichInput = forwardRef<MessageInputHandle, Props>(function RichInput(
  { value, onChange, windows, disabled, placeholder, onKeyDown, onPaste },
  ref,
) {
  const box = useRef<HTMLDivElement>(null);
  // The text the box shows. A value from elsewhere (another session's draft, a command filled in, a message sent)
  // is drawn anew; one the box made itself is there already, and drawing it again would lose the caret.
  const shown = useRef<string | null>(null);
  // Where the caret last was in the box, for files added while the focus is elsewhere.
  const caret = useRef<Range | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useLayoutEffect(() => {
    const element = box.current!;
    if (value === shown.current) return;
    shown.current = value;
    draw(element, value, windows, true);
    if (document.activeElement === element) caretAtEnd(element);
  }, [value, windows]);
  useEffect(() => {
    const element = box.current!;
    const keep = () => {
      const selection = getSelection();
      if (selection?.rangeCount && element.contains(selection.anchorNode))
        caret.current = selection.getRangeAt(0).cloneRange();
    };
    // Only what can be typed goes in: no formatting, and a new paragraph is a line break.
    const typed = (event: InputEvent) => {
      if (event.inputType === 'insertParagraph') {
        event.preventDefault();
        document.execCommand('insertLineBreak');
      } else if (
        !/^(?:insert(?:Text|ReplacementText|CompositionText|FromComposition|LineBreak|HTML)|delete|history)/.test(
          event.inputType,
        )
      )
        event.preventDefault();
    };
    // A picture that cannot be shown (moved, deleted, too large) stands as a file.
    const broken = (event: Event) => {
      const image = event.target as HTMLElement;
      if (image.tagName !== 'IMG') return;
      image.parentElement?.classList.add('file');
      image.remove();
    };
    document.addEventListener('selectionchange', keep);
    element.addEventListener('beforeinput', typed);
    element.addEventListener('error', broken, true);
    return () => {
      document.removeEventListener('selectionchange', keep);
      element.removeEventListener('beforeinput', typed);
      element.removeEventListener('error', broken, true);
    };
  }, []);
  function changed() {
    const text = textOf(box.current!);
    shown.current = text;
    if (text !== value) onChange(text);
  }
  // Text, with any quoted paths in it as files, in place of the selection.
  function put(text: string) {
    const holder = document.createElement('div');
    draw(holder, text.replace(/\r\n?/g, '\n'), windows, false);
    document.execCommand('insertHTML', false, holder.innerHTML);
    changed();
  }
  useImperativeHandle(
    ref,
    () => ({
      focus() {
        const element = box.current!;
        element.focus();
        if (!element.contains(getSelection()?.anchorNode ?? null)) caretAtEnd(element);
      },
      insert(paths) {
        const element = box.current!;
        const at = caret.current;
        element.focus();
        if (at && element.contains(at.startContainer)) {
          const selection = getSelection()!;
          selection.removeAllRanges();
          selection.addRange(at);
        } else caretAtEnd(element);
        const before = document.createRange();
        before.selectNodeContents(element);
        const range = getSelection()!.getRangeAt(0);
        before.setEnd(range.startContainer, range.startOffset);
        const lead = textOf(before.cloneContents());
        put(`${lead && !/\s$/.test(lead) ? ' ' : ''}${paths.map(quote).join(' ')} `);
      },
    }),
    [value, onChange, windows],
  );
  // What is copied or cut is the text, paths and all.
  function copy(event: ClipboardEvent<HTMLElement>, cut: boolean) {
    const selection = getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', textOf(selection.getRangeAt(0).cloneContents()));
    if (cut && !disabled) document.execCommand('delete');
  }
  return (
    <>
      <div
        ref={box}
        className="message-input"
        role="textbox"
        aria-multiline="true"
        aria-label="消息"
        aria-disabled={disabled || undefined}
        aria-placeholder={placeholder}
        data-placeholder={placeholder}
        data-empty={value ? undefined : ''}
        contentEditable={!disabled}
        suppressContentEditableWarning
        tabIndex={disabled ? -1 : 0}
        onInput={changed}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          onPaste(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          const text = event.clipboardData.getData('text/plain');
          if (text && !disabled) put(text.slice(0, limit));
        }}
        onCopy={(event) => copy(event, false)}
        onCut={(event) => copy(event, true)}
        onClick={(event) => {
          const target = event.target as HTMLElement;
          const found = target.closest<HTMLElement>('.path-chip');
          if (!found || !box.current!.contains(found)) return;
          const path = found.dataset.path!;
          if (target.closest('.path-chip-remove')) {
            if (disabled) return;
            // The space put in after it goes with it.
            const range = document.createRange();
            range.selectNode(found);
            const next = found.nextSibling;
            if (next?.nodeType === Node.TEXT_NODE && next.nodeValue!.startsWith(' '))
              range.setEnd(next, 1);
            box.current!.focus();
            const selection = getSelection()!;
            selection.removeAllRanges();
            selection.addRange(range);
            document.execCommand('delete');
          } else if (found.querySelector('img')) setPreview(path);
          else void window.desktop!.actOnPath('open', path).catch(() => {});
        }}
        // Text is moved by cutting and pasting; what is dropped from elsewhere comes in as plain text. Files
        // dropped are the form's.
        onDragStart={(event) => event.preventDefault()}
        onDrop={(event) => {
          if (event.dataTransfer.files.length) return;
          event.preventDefault();
          const text = event.dataTransfer.getData('text/plain');
          if (!text || disabled) return;
          const range = document.caretRangeFromPoint(event.clientX, event.clientY);
          box.current!.focus();
          if (range && box.current!.contains(range.startContainer)) {
            const selection = getSelection()!;
            selection.removeAllRanges();
            selection.addRange(range);
          }
          put(text);
        }}
      />
      {preview && (
        <PictureDialog
          src={localPicture(preview)}
          alt={fileName(preview)}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
});

export default window.desktop ? RichInput : PlainInput;
export const messageLimit = limit;
