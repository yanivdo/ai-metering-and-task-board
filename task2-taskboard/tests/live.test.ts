import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectLive } from '../src/api/live';
import { createBoardStore } from '../src/state/store';
import { EventFactory, FakeApi, makeTask } from './fixtures';

/** Minimal stand-in for the browser's EventSource that the test drives by hand. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string; lastEventId: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
  message(data: unknown, lastEventId = '') {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data), lastEventId });
  }
}

function setup() {
  FakeEventSource.instances = [];
  const store = createBoardStore({ api: new FakeApi(), clientId: 'me' });
  const stop = connectLive(store, { EventSourceImpl: FakeEventSource as unknown as typeof EventSource, batchMs: 16, retryMs: 2000 });
  return { store, stop, es: () => FakeEventSource.instances.at(-1)! };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('live connection', () => {
  it('shows connecting, then live once the stream opens', () => {
    const { store, es, stop } = setup();
    expect(store.getState().connection).toBe('connecting');
    es().open();
    expect(store.getState().connection).toBe('live');
    stop();
  });

  it('batches a burst of messages into one store update (#17)', () => {
    vi.useFakeTimers();
    const { store, es, stop } = setup();
    const ev = new EventFactory();
    const task = makeTask();
    let notifications = 0;
    store.subscribe(() => notifications++);

    es().message(ev.snapshot([task]));
    for (let i = 0; i < 20; i++) es().message(ev.updated({ ...task, version: i + 2 }, ['status']));
    expect(notifications).toBe(0); // nothing applied yet: waiting for the frame
    vi.advanceTimersByTime(16);
    expect(notifications).toBe(1);
    expect(store.getState().tasks[task.id]?.version).toBe(21);
    stop();
  });

  it('ignores a malformed message instead of breaking the stream', () => {
    vi.useFakeTimers();
    const { store, es, stop } = setup();
    es().message('{not json');
    es().message(new EventFactory().snapshot([makeTask()]));
    vi.advanceTimersByTime(16);
    expect(Object.keys(store.getState().tasks)).toHaveLength(1);
    stop();
  });

  it('when the browser gives up, reconnects itself and passes the last event id in the URL (#7)', () => {
    vi.useFakeTimers();
    const { store, es, stop } = setup();
    es().open();
    es().message(new EventFactory().snapshot([]), 'epoch-1:7');
    es().readyState = FakeEventSource.CLOSED; // e.g. the server answered with an error
    es().onerror?.();
    expect(store.getState().connection).toBe('reconnecting');
    vi.advanceTimersByTime(2000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(es().url).toBe('/api/events?lastEventId=epoch-1%3A7');
    stop();
  });

  it('while the browser is reconnecting by itself, does not open a second connection', () => {
    vi.useFakeTimers();
    const { es, stop } = setup();
    es().open();
    es().readyState = FakeEventSource.CONNECTING;
    es().onerror?.();
    vi.advanceTimersByTime(10_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    stop();
  });
});
