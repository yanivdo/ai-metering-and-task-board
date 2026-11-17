import type { StoreApi } from 'zustand/vanilla';
import type { ServerEvent } from '../../shared/types';
import type { BoardStore } from '../state/store';

export interface LiveOptions {
  url?: string;
  /** Injectable for tests. */
  EventSourceImpl?: typeof EventSource;
  /** Events arriving within this window are applied as one store update (#17). */
  batchMs?: number;
  /** Delay before reconnecting ourselves when the browser gives up. */
  retryMs?: number;
}

/**
 * Connects the store to the server's event stream (SSE).
 * - The browser's EventSource reconnects by itself and resends Last-Event-ID, so the server replays
 *   what was missed (#7). If the browser gives up (e.g. the server answered with an error), we
 *   reconnect ourselves and pass the last id in the URL, since a new EventSource starts without it.
 * - Events are batched per ~frame: a burst becomes one render (#17), at no visible latency cost.
 * Returns a function that closes the connection.
 */
export function connectLive(store: StoreApi<BoardStore>, opts: LiveOptions = {}): () => void {
  const ES = opts.EventSourceImpl ?? EventSource;
  const url = opts.url ?? '/api/events';
  const batchMs = opts.batchMs ?? 16;
  const retryMs = opts.retryMs ?? 2000;

  let source: EventSource | undefined;
  let queue: ServerEvent[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastEventId = '';
  let closed = false;

  const setConnection = store.getState().setConnection;

  function flushQueue(): void {
    batchTimer = undefined;
    const batch = queue;
    queue = [];
    store.getState().receive(batch);
  }

  function open(): void {
    const target = lastEventId ? `${url}?lastEventId=${encodeURIComponent(lastEventId)}` : url;
    source = new ES(target);
    source.onopen = () => setConnection('live');
    source.onmessage = (message: MessageEvent<string>) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(message.data) as ServerEvent;
      } catch {
        return; // a malformed message must not break the stream
      }
      if (message.lastEventId) lastEventId = message.lastEventId;
      queue.push(event);
      batchTimer ??= setTimeout(flushQueue, batchMs);
    };
    source.onerror = () => {
      if (closed) return;
      setConnection('reconnecting');
      if (source?.readyState === ES.CLOSED) {
        source.close();
        retryTimer = setTimeout(open, retryMs);
      }
      // Otherwise the browser is already reconnecting by itself.
    };
  }

  open();
  return () => {
    closed = true;
    clearTimeout(retryTimer);
    if (batchTimer) flushQueue();
    source?.close();
  };
}
