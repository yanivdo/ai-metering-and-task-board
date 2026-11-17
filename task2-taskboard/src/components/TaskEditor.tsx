import { useState, type KeyboardEvent } from 'react';
import { validateTitle, type Task } from '../../shared/types';
import { formatValue } from '../format';
import { AssigneeSelect, PrioritySelect, StatusSelect } from './fields';
import { isSaving } from '../state/selectors';
import { useBoard } from '../state/useBoard';

/** Edits the selected task. Handles "nothing selected" and "deleted while you were looking at it" (#10). */
export function TaskEditor() {
  const selectedId = useBoard((s) => s.selectedId);
  const task = useBoard((s) => (s.selectedId ? s.tasks[s.selectedId] : undefined));
  const wasDeleted = useBoard((s) => s.selectedId !== null && s.tombstones[s.selectedId] !== undefined);
  const select = useBoard((s) => s.select);

  return (
    <section className="panel editor" aria-labelledby="editor-title">
      <h2 id="editor-title">Editor</h2>
      {!selectedId ? (
        <p className="empty">Select a task to edit it.</p>
      ) : !task ? (
        <div className="notice" role="status">
          <p>{wasDeleted ? 'This task was deleted.' : 'This task no longer exists.'}</p>
          <button type="button" onClick={() => select(null)}>Close</button>
        </div>
      ) : (
        // key: switching tasks starts with a fresh title draft
        <EditorFields key={task.id} task={task} />
      )}
    </section>
  );
}

function EditorFields({ task }: { task: Task }) {
  const updateTask = useBoard((s) => s.updateTask);
  const saving = useBoard((s) => isSaving(s, task.id));

  // The title is edited as a local draft and saved on Enter/blur, not on every keystroke.
  // null = not editing: the field shows the live value.
  const [draft, setDraft] = useState<string | null>(null);
  const [draftBase, setDraftBase] = useState(task.title);
  const [error, setError] = useState<string | null>(null);

  function startEditing() {
    if (draft === null) {
      setDraft(task.title);
      setDraftBase(task.title);
    }
  }

  function commit() {
    if (draft === null) return;
    // You didn't change the text (just focused and left, or typed and changed it back): nothing to
    // save. Saving here would silently overwrite a rename someone else made meanwhile (#28).
    if (draft === draftBase) {
      setDraft(null);
      setError(null);
      return;
    }
    const result = validateTitle(draft);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (result.title !== task.title) updateTask(task.id, { title: result.title });
    setDraft(null);
    setError(null);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') {
      setDraft(null);
      setError(null);
    }
  }

  // Someone else changed the title while you were typing: keep your draft, but tell you (#11).
  const changedUnderYou = draft !== null && task.title !== draftBase;

  return (
    <div className="editor-fields">
      <label>
        Title
        <input
          aria-label="Title"
          value={draft ?? task.title}
          onFocus={startEditing}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
          aria-invalid={error !== null}
        />
      </label>
      {error && <p className="field-error" role="alert">{error}</p>}
      {changedUnderYou && (
        <p className="notice" role="status">
          Someone else changed the title to {formatValue('title', task.title)}. Saving will replace it.
        </p>
      )}

      <label>
        Status
        <StatusSelect task={task} label="Editor status" />
      </label>
      <label>
        Assignee
        <AssigneeSelect task={task} label="Editor assignee" />
      </label>
      <label>
        Priority
        <PrioritySelect task={task} label="Editor priority" />
      </label>

      <p className="meta">
        Version {task.version === 0 ? '(not saved yet)' : task.version} · updated {new Date(task.updatedAt).toLocaleTimeString()}
        {saving && ' · saving…'}
      </p>
    </div>
  );
}
