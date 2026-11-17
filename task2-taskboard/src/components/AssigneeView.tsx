import { formatValue } from '../format';
import { selectGroupsByAssignee } from '../state/selectors';
import { useBoard } from '../state/useBoard';
import { AssigneeSelect, StatusSelect } from './fields';

/**
 * Tasks grouped by person (plus "Unassigned"). Each task can be edited right here: change its status,
 * or reassign it, which moves it to the other person's group in every view at once.
 * Click a title to open the task in the editor.
 */
export function AssigneeView() {
  const groups = useBoard(selectGroupsByAssignee);
  const select = useBoard((s) => s.select);

  return (
    <section className="panel assignees" aria-labelledby="assignees-title">
      <h2 id="assignees-title">By person</h2>
      <div className="groups">
        {groups.map((g) => (
          <div className="group" key={g.assignee ?? 'unassigned'} data-testid={`group-${g.assignee ?? 'unassigned'}`}>
            <h3>
              {formatValue('assignee', g.assignee)} <span className="count">{g.tasks.length}</span>
            </h3>
            {g.tasks.length === 0 ? (
              <p className="empty">No tasks</p>
            ) : (
              <ul>
                {g.tasks.map((t) => (
                  <li key={t.id}>
                    <button type="button" className="link" onClick={() => select(t.id)}>{t.title}</button>
                    <span className="group-fields">
                      <StatusSelect task={t} label={`Status of ${t.title} (by person)`} />
                      <AssigneeSelect task={t} label={`Reassign ${t.title}`} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
