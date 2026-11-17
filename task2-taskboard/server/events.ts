import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { ServerEvent } from '../shared/types';
import type { TaskStore } from './taskStore';

export interface EventStreamOptions {
  heartbeatMs?: number;
  /** A client whose unsent backlog exceeds this many bytes is dropped; it reconnects and catches up by replay. */
  maxBufferedBytes?: number;
  /** Reconnect delay suggested to the browser's EventSource. */
  retryMs?: number;
}

/** Last-Event-ID is "<epoch>:<seq>", so a resume after a server restart is detected (different epoch). */
function eventId(event: ServerEvent): string {
  return `${event.epoch}:${event.seq}`;
}

function format(event: ServerEvent): string {
  return `id: ${eventId(event)}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** What a (re)connecting client should get first: missed events if we still have them, otherwise a snapshot. */
export function initialEvents(store: TaskStore, lastEventId: string | undefined): ServerEvent[] {
  if (lastEventId) {
    const [epoch, seqText] = lastEventId.split(':');
    const seq = Number(seqText);
    if (epoch === store.epoch && Number.isSafeInteger(seq)) {
      const missed = store.eventsSince(seq);
      if (missed) return missed;
    }
  }
  return [store.snapshot()];
}

/**
 * GET /api/events: Server-Sent Events.
 * The first message is a snapshot (or the replay of missed events), so the initial state and the
 * live updates come from one ordered stream and can't race each other.
 */
export function registerEventStream(app: FastifyInstance, store: TaskStore, opts: EventStreamOptions = {}): void {
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const maxBufferedBytes = opts.maxBufferedBytes ?? 1_000_000;
  const retryMs = opts.retryMs ?? 2_000;
  const open = new Set<ServerResponse>();

  app.get<{ Querystring: { lastEventId?: string } }>('/api/events', (request, reply) => {
    // The browser resends Last-Event-ID as a header when it reconnects by itself; our own
    // reconnect (a new EventSource) can only pass it in the URL.
    const header = request.headers['last-event-id'];
    const lastEventId = typeof header === 'string' ? header : request.query.lastEventId;
    reply.hijack(); // we write the stream ourselves; Fastify won't send a response
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // tell reverse proxies not to buffer the stream
    });

    /**
     * Bytes still queued from the initial snapshot/replay; the slow-client limit comes on top of this.
     * Infinity while the initial events are being written: no limit for them.
     */
    let initialBacklog = Number.POSITIVE_INFINITY;
    const send = (chunk: string) => {
      // After destroy()/end(), more events can arrive before 'close' unsubscribes us: never write to a closed stream.
      if (res.destroyed || res.writableEnded) return;
      res.write(chunk);
      // Slow consumer: if live events pile up unread, drop it; it reconnects and catches up by replay (#23).
      // The initial snapshot doesn't count, or a large board could never connect (#29).
      if (res.writableLength > initialBacklog + maxBufferedBytes) res.destroy();
    };

    send(`retry: ${retryMs}\n\n`);
    for (const event of initialEvents(store, lastEventId)) send(format(event));
    initialBacklog = res.writableLength;

    const unsubscribe = store.subscribe((event) => send(format(event)));
    const heartbeat = setInterval(() => send(': ping\n\n'), heartbeatMs); // SSE comment line, ignored by clients
    open.add(res);

    res.on('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
      open.delete(res);
    });
  });

  // Graceful shutdown: an SSE response never ends by itself, so end them all, or close() would wait forever.
  app.addHook('preClose', async () => {
    for (const res of open) res.end();
  });
}
