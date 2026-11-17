import { PRIORITIES, STATUSES, TEAM, type Member, type Priority, type Status, type Task } from '../../shared/types';
import { formatValue } from '../format';
import { useBoard } from '../state/useBoard';

/**
 * The editable fields, shared by every component that edits a task (list, editor, person view),
 * so they always offer the same options and save the same way.
 */
interface FieldProps {
  task: Task;
  label: string;
}

/** Clicks on a dropdown inside a clickable row must not also select the row. */
const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

export function StatusSelect({ task, label }: FieldProps) {
  const updateTask = useBoard((s) => s.updateTask);
  return (
    <select aria-label={label} value={task.status} onClick={stop} onChange={(e) => updateTask(task.id, { status: e.target.value as Status })}>
      {STATUSES.map((s) => (
        <option key={s} value={s}>{formatValue('status', s)}</option>
      ))}
    </select>
  );
}

export function AssigneeSelect({ task, label }: FieldProps) {
  const updateTask = useBoard((s) => s.updateTask);
  return (
    <select
      aria-label={label}
      value={task.assignee ?? ''}
      onClick={stop}
      onChange={(e) => updateTask(task.id, { assignee: (e.target.value || null) as Member | null })}
    >
      <option value="">Unassigned</option>
      {TEAM.map((m) => (
        <option key={m} value={m}>{m}</option>
      ))}
      {/* An assignee this client doesn't know (newer server) stays visible instead of looking unassigned. */}
      {task.assignee !== null && !TEAM.includes(task.assignee) && <option value={task.assignee}>{task.assignee}</option>}
    </select>
  );
}

export function PrioritySelect({ task, label }: FieldProps) {
  const updateTask = useBoard((s) => s.updateTask);
  return (
    <select aria-label={label} value={task.priority} onClick={stop} onChange={(e) => updateTask(task.id, { priority: e.target.value as Priority })}>
      {PRIORITIES.map((p) => (
        <option key={p} value={p}>{formatValue('priority', p)}</option>
      ))}
    </select>
  );
}
