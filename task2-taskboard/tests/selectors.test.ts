import { describe, expect, it } from 'vitest';
import {
  applyLocalChanges,
  applyLocalCreate,
  applyLocalDelete,
  applyServerEvents,
  initialBoardState,
  resolveUpdate,
  type BoardState,
} from '../src/state/reducer';
import { selectGroupsByAssignee, selectSortedIds, selectStatusCounts } from '../src/state/selectors';
import { PRIORITIES, STATUSES, TEAM, type Member, type Task } from '../shared/types';
import { EventFactory, makeTask, seededRandom } from './fixtures';

const stateOf = (tasks: Task[]) => applyServerEvents(initialBoardState(), [new EventFactory().snapshot(tasks)], 'me', 0);

describe('derived data', () => {
  it('counts by status and groups by assignee', () => {
    const s = stateOf([
      makeTask({ status: 'done', assignee: 'Alice' }),
      makeTask({ status: 'todo', assignee: 'Alice' }),
      makeTask({ status: 'in_progress', assignee: null }),
    ]);
    expect(selectStatusCounts(s)).toEqual({ todo: 1, in_progress: 1, done: 1, total: 3 });
    const groups = selectGroupsByAssignee(s);
    expect(groups.map((g) => [g.assignee, g.tasks.length, g.open])).toEqual([
      ['Alice', 2, 1], ['Bob', 0, 0], ['Carol', 0, 0], ['Dan', 0, 0], [null, 1, 1],
    ]);
  });

  it('the same tasks object returns the same result object (no needless re-render)', () => {
    const s = stateOf([makeTask()]);
    expect(selectStatusCounts(s)).toBe(selectStatusCounts({ tasks: s.tasks }));
    expect(selectSortedIds(s)).toBe(selectSortedIds(s));
  });

  it('empty board: zeros and empty groups, no errors (#20)', () => {
    const s = initialBoardState();
    expect(selectStatusCounts(s)).toEqual({ todo: 0, in_progress: 0, done: 0, total: 0 });
    expect(selectSortedIds(s)).toEqual([]);
    expect(selectGroupsByAssignee(s).every((g) => g.tasks.length === 0)).toBe(true);
  });

  it('an assignee unknown to this client still appears, so the groups add up to the total', () => {
    const s = stateOf([makeTask({ assignee: 'Eve' as Member })]);
    const groups = selectGroupsByAssignee(s);
    expect(groups.reduce((n, g) => n + g.tasks.length, 0)).toBe(selectStatusCounts(s).total);
  });

  it('list order is oldest first and stable', () => {
    const a = makeTask({ createdAt: 5 });
    const b = makeTask({ createdAt: 1 });
    expect(selectSortedIds(stateOf([a, b]))).toEqual([b.id, a.id]);
  });
});

describe('derived data never out of sync (#2): property test over random operation sequences', () => {
  /** Recount everything from scratch, without the selectors. */
  function expected(s: BoardState) {
    const tasks = Object.values(s.tasks);
    const counts = { todo: 0, in_progress: 0, done: 0, total: tasks.length };
    for (const t of tasks) counts[t.status]++;
    return counts;
  }

  it.each([1, 2, 3])('seed %i: after every one of 1,000 random operations the derived data matches a recount', (seed) => {
    const random = seededRandom(seed);
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
    const ev = new EventFactory();
    let s = applyServerEvents(initialBoardState(), [ev.snapshot([makeTask(), makeTask()])], 'me', 0);

    for (let i = 0; i < 1000; i++) {
      const ids = Object.keys(s.tasks);
      const roll = random();
      const id = ids.length ? pick(ids) : undefined;
      const server = id ? s.confirmed[id] : undefined;

      if (!id || roll < 0.15) {
        s = applyServerEvents(s, [ev.created(makeTask({ assignee: pick([null, ...TEAM]), status: pick(STATUSES) }))], 'me', i);
      } else if (roll < 0.25 && server && server.version > 0) {
        s = applyServerEvents(s, [ev.deleted(server)], 'me', i);
      } else if (roll < 0.55 && server && server.version > 0) {
        const next = { ...server, status: pick(STATUSES), assignee: pick([null, ...TEAM]), version: server.version + 1 };
        s = applyServerEvents(s, [ev.updated(next, ['status', 'assignee'])], 'me', i);
      } else if (roll < 0.8) {
        const changes = { status: pick(STATUSES), priority: pick(PRIORITIES) };
        s = applyLocalChanges(s, id, changes, i);
        if (random() < 0.5 && server) s = resolveUpdate(s, id, changes, random() < 0.5 ? { kind: 'failed', message: 'x' } : { kind: 'ok', task: { ...server, ...changes, version: server.version + 1 } }, i);
      } else if (roll < 0.9) {
        s = applyLocalDelete(s, id, i);
      } else {
        s = applyLocalCreate(s, { id: `local-${i}`, title: 't', assignee: pick([null, ...TEAM]), status: pick(STATUSES), priority: 'low' }, i);
      }

      const counts = selectStatusCounts(s);
      expect(counts).toEqual(expected(s));
      const groups = selectGroupsByAssignee(s);
      expect(groups.reduce((n, g) => n + g.tasks.length, 0)).toBe(counts.total);
      expect(selectSortedIds(s)).toHaveLength(counts.total);
      for (const g of groups) for (const t of g.tasks) expect(s.tasks[t.id]).toBe(t); // groups hold the current objects
    }
  });
});
