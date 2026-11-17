import { useBoard } from '../state/useBoard';

const LABEL = { connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting…' } as const;

/** Connection state of the live stream, plus the last error (dismissible) (#12). */
export function ConnectionBadge() {
  const connection = useBoard((s) => s.connection);
  const error = useBoard((s) => s.error);
  const dismissError = useBoard((s) => s.dismissError);

  return (
    <div className="status-bar">
      <span className={`connection connection-${connection}`} role="status">
        {LABEL[connection]}
      </span>
      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button type="button" className="icon-button" aria-label="Dismiss error" onClick={dismissError}>✕</button>
        </div>
      )}
    </div>
  );
}
