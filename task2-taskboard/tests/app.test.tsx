// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { createBoardStore } from '../src/state/store';
import { BoardProvider } from '../src/state/useBoard';
import type { ServerEvent, Task } from '../shared/types';
import { EventFactory, FakeApi, makeTask } from './fixtures';

afterEach(cleanup);

function renderBoard(tasks: Task[]) {
  const api = new FakeApi();
  const store = createBoardStore({ api, clientId: 'me', now: () => Date.UTC(2026, 0, 1, 10) });
  const ev = new EventFactory();
  store.getState().receive([ev.snapshot(tasks)]);
  render(
    <BoardProvider store={store}>
      <App />
    </BoardProvider>,
  );
  const serverSends = (...events: ServerEvent[]) => act(() => store.getState().receive(events));
  return { api, store, ev, serverSends };
}

const count = (testId: string) => screen.getByTestId(testId).textContent;
const group = (who: string) => within(screen.getByTestId(`group-${who}`));
const list = () => within(screen.getByRole('region', { name: /^Tasks/ }));

describe('every component shows the same data (#1)', () => {
  it('a status change in the LIST updates the summary, person view, editor and activity log together', () => {
    const a = makeTask({ title: 'Alpha', assignee: 'Alice', status: 'todo' });
    const b = makeTask({ title: 'Beta', assignee: 'Bob', status: 'done' });
    renderBoard([a, b]);
    fireEvent.click(screen.getAllByText('Alpha')[0]!); // select it, so the editor shows it too

    fireEvent.change(screen.getByLabelText('Status of Alpha'), { target: { value: 'done' } });

    expect(count('count-done')).toBe('2');
    expect(count('count-todo')).toBe('0');
    expect((group('Alice').getByLabelText('Status of Alpha (by person)') as HTMLSelectElement).value).toBe('done');
    expect((screen.getByLabelText('Editor status') as HTMLSelectElement).value).toBe('done');
    expect(screen.getByText('you')).toBeTruthy();
    expect(screen.getByText(/status: To do → Done/)).toBeTruthy();
  });

  it('a change in the EDITOR updates the list, summary and person view', () => {
    const a = makeTask({ title: 'Alpha', assignee: 'Alice' });
    renderBoard([a]);
    fireEvent.click(screen.getAllByText('Alpha')[0]!);
    fireEvent.change(screen.getByLabelText('Editor assignee'), { target: { value: 'Carol' } });

    expect(count('assignee-count-Carol')).toBe('1');
    expect(count('assignee-count-Alice')).toBe('0');
    expect(group('Carol').getByText('Alpha')).toBeTruthy();
    const row = list().getByText('Alpha').closest('li')!;
    expect(within(row).getByText('Carol')).toBeTruthy();
  });

  it('edits in the PERSON VIEW (reassign, status) update every other component', () => {
    const a = makeTask({ title: 'Alpha', assignee: 'Alice', status: 'todo' });
    renderBoard([a]);
    fireEvent.click(screen.getAllByText('Alpha')[0]!); // open in the editor too

    fireEvent.change(group('Alice').getByLabelText('Reassign Alpha'), { target: { value: 'Carol' } });
    expect(group('Alice').getByText('No tasks')).toBeTruthy(); // moved out of Alice's group...
    expect(group('Carol').getByText('Alpha')).toBeTruthy(); // ...into Carol's
    expect(count('assignee-count-Carol')).toBe('1');
    expect(within(list().getByText('Alpha').closest('li')!).getByText('Carol')).toBeTruthy();
    expect((screen.getByLabelText('Editor assignee') as HTMLSelectElement).value).toBe('Carol');

    fireEvent.change(group('Carol').getByLabelText('Status of Alpha (by person)'), { target: { value: 'in_progress' } });
    expect(count('count-in_progress')).toBe('1');
    expect((screen.getByLabelText('Status of Alpha') as HTMLSelectElement).value).toBe('in_progress');
    expect(screen.getByText(/status: To do → In progress/)).toBeTruthy();
  });

  it('a change from the SERVER reaches every component', () => {
    const a = makeTask({ title: 'Alpha', assignee: 'Alice', status: 'todo' });
    const { ev, serverSends } = renderBoard([a]);
    fireEvent.click(screen.getAllByText('Alpha')[0]!);

    serverSends(ev.updated({ ...a, status: 'in_progress', assignee: 'Dan', version: 2 }, ['status', 'assignee']));

    expect(count('count-in_progress')).toBe('1');
    expect(count('assignee-count-Dan')).toBe('1');
    expect((screen.getByLabelText('Status of Alpha') as HTMLSelectElement).value).toBe('in_progress');
    expect((screen.getByLabelText('Editor assignee') as HTMLSelectElement).value).toBe('Dan');
    expect(screen.getByText('server')).toBeTruthy();
  });
});

describe('adding and deleting (requirement 2)', () => {
  it('a new task appears in the list, summary and person view at once', () => {
    renderBoard([]);
    fireEvent.change(screen.getByLabelText('New task title'), { target: { value: 'Brand new' } });
    fireEvent.change(screen.getByLabelText('New task assignee'), { target: { value: 'Bob' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(count('count-total')).toBe('1');
    expect(group('Bob').getByText('Brand new')).toBeTruthy();
    expect((screen.getByLabelText('New task title') as HTMLInputElement).value).toBe(''); // cleared: no double submit
  });

  it('an invalid title is rejected in the form and nothing is created (#14)', () => {
    const { api } = renderBoard([]);
    fireEvent.change(screen.getByLabelText('New task title'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert').textContent).toMatch(/required/);
    expect(api.calls).toHaveLength(0);
  });

  it('deleting removes the task from every component', () => {
    const a = makeTask({ title: 'Alpha', assignee: 'Alice' });
    renderBoard([a]);
    fireEvent.click(screen.getByLabelText('Delete Alpha'));
    expect(count('count-total')).toBe('0');
    expect(group('Alice').getByText('No tasks')).toBeTruthy();
  });
});

describe('edge cases in the UI', () => {
  it('an unconfirmed edit shows the saving dot; the delete button shows its icon', () => {
    renderBoard([makeTask({ title: 'Alpha' })]);
    const row = within(screen.getByRole('region', { name: /^Tasks/ })).getByText('Alpha').closest('li')!;
    fireEvent.change(screen.getByLabelText('Status of Alpha'), { target: { value: 'done' } }); // server hasn't answered
    expect(within(row).getByLabelText('Saving').textContent).toBe('•');
    expect(within(row).getByLabelText('Delete Alpha').textContent?.trim()).toBe('✕');
  });

  it('the selected task deleted by someone else: the editor says so instead of breaking (#10)', () => {
    const a = makeTask({ title: 'Alpha' });
    const { ev, serverSends } = renderBoard([a]);
    fireEvent.click(screen.getAllByText('Alpha')[0]!);
    serverSends(ev.deleted(a, 'client:other-tab'));
    expect(screen.getByText('This task was deleted.')).toBeTruthy();
    expect(screen.queryByLabelText('Editor status')).toBeNull();
  });

  it('your title draft is kept when the server changes the title meanwhile, with a notice (#11)', () => {
    const a = makeTask({ title: 'Alpha' });
    const { ev, serverSends } = renderBoard([a]);
    fireEvent.click(screen.getAllByText('Alpha')[0]!);
    const input = screen.getByLabelText('Title') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'My new title' } });

    serverSends(ev.updated({ ...a, title: 'Server title', version: 2 }, ['title']));

    expect(input.value).toBe('My new title');
    expect(screen.getByText(/Someone else changed the title to "Server title"/)).toBeTruthy();
  });

  it('focusing the title and leaving without changing it never overwrites a rename by someone else (#28)', () => {
    const a = makeTask({ title: 'Alpha' });
    const { api, ev, serverSends, store } = renderBoard([a]);
    fireEvent.click(screen.getAllByText('Alpha')[0]!);
    const input = screen.getByLabelText('Title') as HTMLInputElement;

    fireEvent.focus(input); // clicked in, typed nothing
    serverSends(ev.updated({ ...a, title: 'Renamed by server', version: 2 }, ['title']));
    fireEvent.blur(input);

    fireEvent.focus(input); // typed, then changed it back
    fireEvent.change(input, { target: { value: 'Renamed by server!' } });
    fireEvent.change(input, { target: { value: 'Renamed by server' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(api.calls.filter((c) => c.op === 'update')).toHaveLength(0);
    expect(store.getState().tasks[a.id]?.title).toBe('Renamed by server');
    expect(input.value).toBe('Renamed by server');
  });

  it('HTML in a title is shown as text, never rendered as HTML (#21)', () => {
    const evil = '<img src=x onerror="alert(1)">';
    renderBoard([makeTask({ title: evil })]);
    expect(screen.getAllByText(evil).length).toBeGreaterThan(0);
    expect(document.querySelector('img')).toBeNull();
  });

  it('empty board: zeros and empty-state messages (#20)', () => {
    renderBoard([]);
    expect(count('count-total')).toBe('0');
    expect(screen.getByText('No tasks yet. Add one above.')).toBeTruthy();
    expect(screen.getByText('Select a task to edit it.')).toBeTruthy();
    expect(screen.getByText('No changes yet.')).toBeTruthy();
  });
});
