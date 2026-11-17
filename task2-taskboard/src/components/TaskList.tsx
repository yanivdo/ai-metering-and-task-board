import { useShallow } from 'zustand/react/shallow';
import { selectSortedIds } from '../state/selectors';
import { useBoard } from '../state/useBoard';
import { NewTaskForm } from './NewTaskForm';
import { TaskRow } from './TaskRow';

/**
 * All tasks. Subscribes only to the sorted id list (compared item by item), so it re-renders when
 * tasks are added, removed or reordered, not when a task's fields change (the row handles that).
 */
export function TaskList() {
  const ids = useBoard(useShallow(selectSortedIds));
  return (
    <section className="panel task-list" aria-labelledby="task-list-title">
      <h2 id="task-list-title">
        Tasks <span className="count">{ids.length}</span>
      </h2>
      <NewTaskForm />
      {ids.length === 0 ? (
        <p className="empty">No tasks yet. Add one above.</p>
      ) : (
        <ul className="rows">
          {ids.map((id) => (
            <TaskRow key={id} id={id} />
          ))}
        </ul>
      )}
    </section>
  );
}
