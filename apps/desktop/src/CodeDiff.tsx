import { useContext, useState } from 'react';
import { diffLines, previewLines, type EditInput } from './edit-input.ts';
import { highlightLine, languageOf } from './code-highlight.ts';
import { CopyButton } from './copy.tsx';
import { documentKind, OpenDocument } from './file-preview.ts';

export default function CodeDiff({ input }: { input: EditInput }) {
  const [error, setError] = useState('');
  const openDocument = useContext(OpenDocument);
  const content = input.changes.map((change) => change.newText).join('\n');
  const streaming = input.partial === true;
  const language = streaming ? null : languageOf(input.path);
  const kind = documentKind(input.path);
  const open = (reveal: boolean) =>
    void window.desktop!.openChangedFile(input.path, reveal).catch((e: Error) => setError(e.message));
  return (
    <section className="code-diff" data-file-path={input.path} aria-label={`${input.path} 修改内容`}>
      <header className="code-diff-heading">
        {kind ? (
          <button
            type="button"
            className="code-diff-path"
            title={`${input.path}\n在右侧预览`}
            onClick={() => openDocument({ path: input.path, fallback: content })}
          >
            {input.path}
          </button>
        ) : (
          <span title={input.path}>{input.path}</span>
        )}
        {window.desktop && (
          <>
            <button type="button" onClick={() => open(true)}>
              定位
            </button>
            <button type="button" onClick={() => open(false)}>
              打开
            </button>
          </>
        )}
        <CopyButton text={content} label="复制修改后正文" />
      </header>
      {error && <p role="alert">{error}</p>}
      {input.changes.map((change, part) => (
        <pre
          key={part}
          className="code-diff-lines"
          data-search-content
          aria-label={`第 ${part + 1} 段（片段行号）`}
        >
          {(streaming ? previewLines(change) : diffLines(change)).map((line, index) => {
            const html = highlightLine(line.text, language);
            return (
              <span className={`code-diff-line ${line.type}`} key={index}>
                <b aria-hidden="true">{line.type === 'remove' ? '−' : line.type === 'add' ? '+' : ' '}</b>
                <i aria-hidden="true">{line.number ?? ''}</i>
                {html ? <span dangerouslySetInnerHTML={{ __html: html }} /> : line.text}
                {'\n'}
              </span>
            );
          })}
        </pre>
      ))}
    </section>
  );
}
