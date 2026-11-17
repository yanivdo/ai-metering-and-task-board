import type { EditableField } from '../shared/types';

/** Display labels, used by the views and by the activity log text. */
const LABELS: Record<string, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export function formatValue(field: EditableField, value: unknown): string {
  if (field === 'assignee') return value === null ? 'Unassigned' : String(value);
  if (field === 'title') return `"${String(value)}"`;
  return LABELS[String(value)] ?? String(value);
}
