import { useBoard } from '../state/useBoard';

/** Recent changes, newest first (capped in the reducer). */
export function ActivityLog() {
  const activity = useBoard((s) => s.activity);

  return (
    <section className="panel activity" aria-labelledby="activity-title">
      <h2 id="activity-title">Activity</h2>
      {activity.length === 0 ? (
        <p className="empty">No changes yet.</p>
      ) : (
        <ol className="log" aria-live="polite">
          {activity.map((a) => (
            <li key={a.id} className={`log-entry kind-${a.kind}`}>
              <time dateTime={new Date(a.at).toISOString()}>{new Date(a.at).toLocaleTimeString()}</time>
              <span className={`actor actor-${a.actor.replace(' ', '-')}`}>{a.actor}</span>
              <span className="what">
                {a.kind} <strong>{a.title}</strong>
                {a.detail && <span className="detail"> ({a.detail})</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
