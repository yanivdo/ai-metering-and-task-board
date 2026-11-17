import { memo } from 'react';
import { formatValue } from '../format';
import { StatusSelect } from './fields';
import { isSaving } from '../state/selectors';
import { useBoard } from '../state/useBoard';

/** One task in the list. Subscribes to its own task only, so other tasks' changes don't re-render it. */
export const TaskRow = memo(function TaskRow({ id }: { id: string }) {
  const task = useBoard((s) => s.tasks[id]);
  const selected = useBoard((s) => s.selectedId === id);
  const saving = useBoard((s) => isSaving(s, id));
  const select = useBoard((s) => s.select);
  const deleteTask = useBoard((s) => s.deleteTask);

  if (!task) return null;
  return (
    <li className={`task-row${selected ? ' selected' : ''}`} onClick={() => select(id)} aria-current={selected || undefined}>
      <span className="task-title" title={task.title}>{task.title}</span>
      <span className="task-assignee">{formatValue('assignee', task.assignee)}</span>
      <StatusSelect task={task} label={`Status of ${task.title}`} />
      <span className={`badge priority-${task.priority}`}>{formatValue('priority', task.priority)}</span>
      <span className="saving" aria-label={saving ? 'Saving' : undefined}>{saving ? '•' : ''}</span>
      <button
        type="button"
        className="icon-button"
        aria-label={`Delete ${task.title}`}
        onClick={(e) => {
          e.stopPropagation();
          deleteTask(id);
        }}
      >
        ✕
      </button>
    </li>
  );
});
