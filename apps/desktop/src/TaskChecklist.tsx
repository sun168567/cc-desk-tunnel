import { useState } from 'react';
import { ChevronDown, ChevronUp, Circle, CircleCheck, LoaderCircle } from 'lucide-react';
import type { Task } from '@cc-desk-tunnel/protocol';
import { useT } from './i18n.ts';

// Claude Code's task list as it stands (see tasks.ts of the protocol), above the message box while some of it is
// unfinished, as the CLI shows it in a terminal. Folded, it keeps the step under way in view.
export default function TaskChecklist({ tasks, working }: { tasks: Task[]; working: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const done = tasks.filter((task) => task.status === 'completed').length;
  if (!tasks.length || done === tasks.length) return null;
  const current = tasks.find((task) => task.status === 'in_progress');
  const words = (task: Task) =>
    task.status === 'in_progress' ? (task.activeForm ?? task.content) : task.content;
  return (
    <section className="task-checklist" aria-label={t('session:tasks.label')}>
      <button
        type="button"
        className="task-checklist-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <strong>{t('session:tasks.progress', { done, count: tasks.length })}</strong>
        {!open && current && <span className="task-current">{words(current)}</span>}
        {open ? <ChevronDown /> : <ChevronUp />}
      </button>
      {open && (
        <ol>
          {tasks.map((task) => (
            <li key={task.id} className={task.status}>
              {task.status === 'completed' ? (
                <CircleCheck />
              ) : task.status === 'in_progress' ? (
                <LoaderCircle className={working ? 'spinning' : ''} />
              ) : (
                <Circle />
              )}
              <span>{words(task)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
