import { useState } from 'react';
import { Check, X } from 'lucide-react';

type Question = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};
// The input of Claude Code's AskUserQuestion tool, as far as it can be shown; null when it is something else.
export function questionsOf(input: string): Question[] | null {
  try {
    const { questions } = JSON.parse(input);
    if (!Array.isArray(questions) || !questions.length) return null;
    const usable = questions.every(
      (item) =>
        typeof item?.question === 'string' &&
        Array.isArray(item.options) &&
        item.options.every(
          (option: unknown) => typeof (option as { label?: unknown })?.label === 'string',
        ),
    );
    return usable ? questions : null;
  } catch {
    return null;
  }
}

// Claude's question with its choices. Every question also takes an answer in the user's own words, as the
// official interface does. Answers go back keyed by the question's text; several choices are joined.
export default function QuestionCard({
  questions,
  busy,
  answer,
  skip,
}: {
  questions: Question[];
  busy: boolean;
  answer: (answers: Record<string, string>) => void;
  skip: () => void;
}) {
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const answers = Object.fromEntries(
    questions.map(({ question }) => [
      question,
      [
        ...(chosen[question] ?? []),
        ...(other[question]?.trim() ? [other[question].trim()] : []),
      ].join(', '),
    ]),
  );
  const complete = Object.values(answers).every(Boolean);
  return (
    <form
      className="question-card"
      aria-label="Claude 的提问"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete) answer(answers);
      }}
    >
      {questions.map(({ question, header, multiSelect, options }) => (
        <fieldset key={question} disabled={busy}>
          <legend>
            {header && <span className="question-header">{header}</span>}
            {question}
            {multiSelect && <small>可多选</small>}
          </legend>
          {options.map(({ label, description }) => {
            const picked = chosen[question]?.includes(label) ?? false;
            return (
              <button
                type="button"
                key={label}
                role={multiSelect ? 'checkbox' : 'radio'}
                aria-checked={picked}
                aria-label={label}
                className="question-option"
                onClick={() => {
                  setChosen((current) => {
                    const now = current[question] ?? [];
                    return {
                      ...current,
                      [question]: !multiSelect
                        ? picked
                          ? []
                          : [label]
                        : picked
                          ? now.filter((item) => item !== label)
                          : [...now, label],
                    };
                  });
                  // One choice among alternatives replaces an answer typed before.
                  if (!multiSelect) setOther((current) => ({ ...current, [question]: '' }));
                }}
              >
                <span>
                  {label}
                  {description && <small>{description}</small>}
                </span>
                {picked && <Check />}
              </button>
            );
          })}
          <input
            aria-label={`其他回答：${question}`}
            placeholder="其他（自己写）"
            maxLength={2000}
            value={other[question] ?? ''}
            onChange={(event) => {
              setOther((current) => ({ ...current, [question]: event.target.value }));
              if (!multiSelect && event.target.value)
                setChosen((current) => ({ ...current, [question]: [] }));
            }}
          />
        </fieldset>
      ))}
      <div className="approval-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={skip}>
          <X />
          不回答
        </button>
        <button type="submit" className="button primary" disabled={busy || !complete}>
          <Check />
          提交回答
        </button>
      </div>
    </form>
  );
}
