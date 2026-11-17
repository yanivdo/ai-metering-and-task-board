import { TEAM, type Member, type Status, type Task } from '../../shared/types';

/**
 * Derived data. NEVER stored in the state: always computed from `tasks`, so it can't fall out of sync
 * (requirement 4). Each selector remembers its last input: if `tasks` is the same object, it returns
 * the same result object, so components using it don't re-render and the work isn't repeated.
 */
type Tasks = Record<string, Task>;

function memoOnTasks<R>(compute: (tasks: Tasks) => R): (state: { tasks: Tasks }) => R {
  let lastTasks: Tasks | undefined;
  let lastResult: R;
  return (state) => {
    if (state.tasks !== lastTasks) {
      lastTasks = state.tasks;
      lastResult = compute(state.tasks);
    }
    return lastResult;
  };
}

/** Oldest first; id breaks ties so the order is stable. */
function compareTasks(a: Task, b: Task): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** A task is "saving" while you have unconfirmed changes to it, or its create isn't confirmed yet. */
export function isSaving(state: { pending: Record<string, unknown>; confirmed: Tasks }, id: string): boolean {
  return state.pending[id] !== undefined || state.confirmed[id]?.version === 0;
}

export const selectSortedIds = memoOnTasks((tasks) => Object.values(tasks).sort(compareTasks).map((t) => t.id));

export type StatusCounts = Record<Status, number> & { total: number };

export const selectStatusCounts = memoOnTasks((tasks): StatusCounts => {
  const counts = { todo: 0, in_progress: 0, done: 0, total: 0 };
  for (const t of Object.values(tasks)) {
    counts[t.status]++;
    counts.total++;
  }
  return counts;
});

export interface AssigneeGroup {
  assignee: Member | null;
  tasks: Task[];
  /** How many of this person's tasks are not done yet. */
  open: number;
}

/**
 * Every team member (even with no tasks) plus "Unassigned", in team order. Counts come from the same groups.
 * An assignee unknown to this client (e.g. added by a newer server) gets its own group instead of
 * disappearing, so the groups always add up to the total.
 */
export const selectGroupsByAssignee = memoOnTasks((tasks): AssigneeGroup[] => {
  const groups = new Map<Member | null, Task[]>([...TEAM.map((m) => [m, []] as [Member, Task[]]), [null, []]]);
  for (const t of Object.values(tasks)) {
    const list = groups.get(t.assignee);
    if (list) list.push(t);
    else groups.set(t.assignee, [t]);
  }
  return [...groups].map(([assignee, list]) => ({
    assignee,
    tasks: list.sort(compareTasks),
    open: list.filter((t) => t.status !== 'done').length,
  }));
});
