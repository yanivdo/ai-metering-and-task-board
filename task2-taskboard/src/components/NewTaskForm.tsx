import { useState, type FormEvent } from 'react';
import { PRIORITIES, TEAM, validateTitle, type Member, type Priority } from '../../shared/types';
import { formatValue } from '../format';
import { useBoard } from '../state/useBoard';

/** Adds a task. Same title rules as the server (#14). */
export function NewTaskForm() {
  const createTask = useBoard((s) => s.createTask);
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState<Member | ''>('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const result = validateTitle(title);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    createTask({ title: result.title, assignee: assignee || null, status: 'todo', priority });
    // Cleared right away: a double click submits an empty title the second time, never a duplicate task.
    setTitle('');
    setError(null);
  }

  return (
    <form className="new-task" onSubmit={submit} noValidate>
      <input
        aria-label="New task title"
        placeholder="New task title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        aria-invalid={error !== null}
      />
      <select aria-label="New task assignee" value={assignee} onChange={(e) => setAssignee(e.target.value as Member | '')}>
        <option value="">Unassigned</option>
        {TEAM.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
      <select aria-label="New task priority" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
        {PRIORITIES.map((p) => (
          <option key={p} value={p}>{formatValue('priority', p)}</option>
        ))}
      </select>
      <button type="submit">Add</button>
      {error && <p className="field-error" role="alert">{error}</p>}
    </form>
  );
}
