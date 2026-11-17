import { randomUUID } from 'node:crypto';
import { PRIORITIES, STATUSES, TEAM, type Task, type TaskChanges } from '../shared/types';
import type { TaskStore } from './taskStore';

export interface SimulatorOptions {
  intervalMs: number;
  /** The task count is kept within [minTasks, maxTasks] (#22). */
  minTasks: number;
  maxTasks: number;
  random?: () => number;
}

const TITLES = [
  'Review pull request', 'Fix login bug', 'Write release notes', 'Update dependencies',
  'Design settings page', 'Investigate slow query', 'Add audit logging', 'Refactor billing module',
];

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)]!;
}

/** A value for `field` that differs from the current one, so every simulated update is a real change. */
function changeFor(task: Task, random: () => number): TaskChanges {
  const field = pick(['status', 'priority', 'assignee'] as const, random);
  switch (field) {
    case 'status':
      return { status: pick(STATUSES.filter((s) => s !== task.status), random) };
    case 'priority':
      return { priority: pick(PRIORITIES.filter((p) => p !== task.priority), random) };
    case 'assignee':
      return { assignee: pick([null, ...TEAM].filter((a) => a !== task.assignee), random) };
  }
}

/** One random change: mostly updates, sometimes a create or delete, always within the task-count bounds. */
export function simulateStep(store: TaskStore, opts: SimulatorOptions): void {
  const random = opts.random ?? Math.random;
  const tasks = store.list();
  const roll = random();
  const mustGrow = tasks.length <= opts.minTasks;
  const mustShrink = tasks.length >= opts.maxTasks;

  if (mustGrow || (!mustShrink && roll < 0.15)) {
    store.create(
      {
        id: randomUUID(),
        title: `${pick(TITLES, random)} #${Math.floor(random() * 1000)}`,
        assignee: pick([null, ...TEAM], random),
        status: 'todo',
        priority: pick(PRIORITIES, random),
      },
      'simulator',
    );
  } else if (mustShrink || roll < 0.3) {
    store.delete(pick(tasks, random).id, 'simulator');
  } else {
    const task = pick(tasks, random);
    store.update(task.id, changeFor(task, random), 'simulator');
  }
}

/** Starts the timer. Returns a stop function. */
export function startSimulator(store: TaskStore, opts: SimulatorOptions): () => void {
  const timer = setInterval(() => simulateStep(store, opts), opts.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
