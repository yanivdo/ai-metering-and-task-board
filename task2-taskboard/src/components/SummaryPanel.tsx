import { STATUSES } from '../../shared/types';
import { formatValue } from '../format';
import { selectGroupsByAssignee, selectStatusCounts } from '../state/selectors';
import { useBoard } from '../state/useBoard';

/**
 * Counts by status and by assignee. Both come from memoized selectors over the same `tasks`,
 * so they always match the list exactly (requirement 4).
 */
export function SummaryPanel() {
  const counts = useBoard(selectStatusCounts);
  const groups = useBoard(selectGroupsByAssignee);

  return (
    <section className="panel summary" aria-labelledby="summary-title">
      <h2 id="summary-title">Summary</h2>
      <dl className="stat-tiles">
        <div className="stat">
          <dt>Total</dt>
          <dd data-testid="count-total">{counts.total}</dd>
        </div>
        {STATUSES.map((s) => (
          <div className={`stat status-${s}`} key={s}>
            <dt>{formatValue('status', s)}</dt>
            <dd data-testid={`count-${s}`}>{counts[s]}</dd>
          </div>
        ))}
      </dl>
      <h3>By assignee</h3>
      <table className="by-assignee">
        <thead>
          <tr>
            <th scope="col">Person</th>
            <th scope="col">Tasks</th>
            <th scope="col">Open</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.assignee ?? 'unassigned'}>
              <th scope="row">{formatValue('assignee', g.assignee)}</th>
              <td data-testid={`assignee-count-${g.assignee ?? 'unassigned'}`}>{g.tasks.length}</td>
              <td>{g.open}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
