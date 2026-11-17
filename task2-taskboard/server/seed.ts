import { randomUUID } from 'node:crypto';
import type { Task } from '../shared/types';

/** Sample data loaded on every server start (storage is in memory). */
export function seedTasks(now = Date.now()): Task[] {
  const rows: Array<Pick<Task, 'title' | 'assignee' | 'status' | 'priority'>> = [
    { title: 'Set up CI pipeline', assignee: 'Alice', status: 'done', priority: 'high' },
    { title: 'Design task board layout', assignee: 'Bob', status: 'in_progress', priority: 'medium' },
    { title: 'Write API documentation', assignee: 'Carol', status: 'todo', priority: 'low' },
    { title: 'Fix flaky login test', assignee: 'Dan', status: 'in_progress', priority: 'high' },
    { title: 'Plan sprint review', assignee: 'Alice', status: 'todo', priority: 'medium' },
    { title: 'Upgrade database driver', assignee: null, status: 'todo', priority: 'medium' },
    { title: 'Add dark mode', assignee: 'Bob', status: 'todo', priority: 'low' },
    { title: 'Customer onboarding emails', assignee: 'Carol', status: 'done', priority: 'medium' },
  ];
  // Spread creation times a little so the list has a stable, meaningful order.
  return rows.map((row, i) => ({ ...row, id: randomUUID(), version: 1, createdAt: now - (rows.length - i) * 60_000, updatedAt: now }));
}
