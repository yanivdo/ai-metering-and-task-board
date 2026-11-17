/** The contract between server and browser. Imported by both, so they can never disagree. */

export const STATUSES = ['todo', 'in_progress', 'done'] as const;
export type Status = (typeof STATUSES)[number];

export const PRIORITIES = ['low', 'medium', 'high'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** The team. An assignee must be one of these, or null (unassigned). */
export const TEAM = ['Alice', 'Bob', 'Carol', 'Dan'] as const;
export type Member = (typeof TEAM)[number];

export const TITLE_MAX = 200;

export interface Task {
  id: string;
  title: string;
  assignee: Member | null;
  status: Status;
  priority: Priority;
  /** Increases by 1 on every change. Used to ignore stale events and detect conflicts. */
  version: number;
  createdAt: number;
  updatedAt: number;
}

/** The fields a user (or the simulator) can change. */
export type EditableField = 'title' | 'assignee' | 'status' | 'priority';
export const EDITABLE_FIELDS: readonly EditableField[] = ['title', 'assignee', 'status', 'priority'];
export type TaskChanges = Partial<Pick<Task, EditableField>>;

/** Body of POST /api/tasks. The client chooses the id, so retrying a create is safe. */
export type NewTask = Pick<Task, 'id' | 'title' | 'assignee' | 'status' | 'priority'>;

/** Who made a change: the server's simulator or a browser (identified by its client id). */
export type ChangeSource = 'simulator' | `client:${string}`;

interface EventBase {
  /** Increases by 1 per event; used as the SSE id for resuming after a reconnect. */
  seq: number;
  /** Changes every server start; a different epoch means "start over from a snapshot". */
  epoch: string;
}

export type ServerEvent =
  | (EventBase & { type: 'snapshot'; tasks: Task[] })
  | (EventBase & { type: 'task.created'; task: Task; source: ChangeSource })
  | (EventBase & { type: 'task.updated'; task: Task; changed: EditableField[]; source: ChangeSource })
  | (EventBase & { type: 'task.deleted'; id: string; title: string; version: number; source: ChangeSource });

export const CLIENT_ID_HEADER = 'x-client-id';

/**
 * At least one visible character: not whitespace and not an invisible zero-width character.
 * The same rule runs in the browser form and in the server's JSON schema.
 */
export const VISIBLE_CHAR_PATTERN = '[^\\s\\u200B-\\u200D\\u2060\\uFEFF]';
const VISIBLE_CHAR = new RegExp(VISIBLE_CHAR_PATTERN, 'u');

/** Counts Unicode characters (code points), the same way JSON-schema maxLength does. */
function charCount(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/** Returns the trimmed title, or an error message. */
export function validateTitle(raw: string): { ok: true; title: string } | { ok: false; error: string } {
  const title = raw.trim();
  if (!VISIBLE_CHAR.test(title)) return { ok: false, error: 'Title is required' };
  if (charCount(title) > TITLE_MAX) return { ok: false, error: `Title must be at most ${TITLE_MAX} characters` };
  return { ok: true, title };
}
