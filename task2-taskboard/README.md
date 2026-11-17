# Task 2: Shared-State Team Task Board

A React task board where five components (**task list, task editor, summary panel, assignee view, activity log**) show the same data. An edit anywhere appears everywhere immediately. A mock server changes tasks randomly every few seconds and pushes the changes to every open browser.

## Run it

Requirements: **Node.js 20.19+**.

```bash
cd task2-taskboard
npm start
```

Open **http://127.0.0.1:4000**. `npm start` installs dependencies, builds the React app, and starts one server that serves both the app and the API. Open a second tab to see two "users" stay in sync.

```bash
npm test          # all automated tests
npm run typecheck # TypeScript strict type check
npm run dev       # development: Vite hot reload on :5173 + the API server
```

## State management: the approach and why

### One store, components subscribe to slices: **Zustand**
All shared data lives in **one Zustand store**. No component passes data to another: each one reads the store directly through `useBoard(selector)`, and **re-renders only when the slice it selected changes**:
- a task row subscribes to its own task
- the list subscribes to the list of ids
- the summary subscribes to the counts

One edit is one store update. Every component showing that data re-renders **in the same render**, so the views can never disagree (requirement 1), and components that don't show it don't re-render at all (low latency).

| Option | Why not chosen |
|---|---|
| **Redux Toolkit** | Same model (one store + selectors), but more boilerplate (slices, actions, provider setup) with no extra benefit at this size. Its devtools would be nice, but not worth it here. |
| **Context + useReducer** | Every component reading the context re-renders on **every** change, even unrelated ones. Avoiding that means splitting contexts and hand-written memoization, which is exactly what Zustand's selectors already provide. |
| **Server-state libraries (React Query, etc.)** | Good for request/response caching, but our data arrives as a push stream that must be merged event by event with ordering rules. A plain store with a pure reducer fits better and is easier to explain. |

### All state logic is pure: `src/state/reducer.ts`
Every transition is a **pure function** `(state, input) → new state`: apply server events, apply your edit, resolve the server's answer, roll back. No React and no network. The Zustand store (`store.ts`) only calls these functions and talks to the API, which is why the shared-state logic is fully unit-tested (requirement 5).

### Derived data is computed, never stored: `src/state/selectors.ts`
Counts by status, counts by person, grouping by person and list order are **never stored**. They are pure functions over `tasks`, **memoized on the `tasks` object**: the same input returns the same result object, so they run once per change and cause no extra renders. Because there's no second copy, **derived data can't fall out of sync** (requirement 4). A property test runs 3,000 random operations and checks the derived data against a fresh recount after every one.

### Server → browser: **Server-Sent Events (SSE)**
| Option | Why not chosen |
|---|---|
| **SSE** ✅ | Updates only flow server → browser; your own edits use normal HTTP requests. SSE is built into browsers, reconnects automatically and resends `Last-Event-ID`, so missed events can be replayed. |
| WebSocket | Two-way, which isn't needed here; you'd have to write reconnection and resume yourself. |
| Polling | Adds latency (up to the polling interval) and load even when nothing changes. |

### Consistency rules (what makes it correct, not just fast)
- **The server is the source of truth.** Every task has a `version` that goes up by 1 on every change; every event has an increasing `seq`.
- **An event is applied only if its version is newer** than what the browser has. That handles duplicates, out-of-order delivery and the echo of your own edits.
- **First load can't race live updates:** the first message on the stream is a **snapshot**, so the initial data and the updates come from one ordered stream.
- **Reconnect:** the browser resends the last event id; the server replays what was missed, or sends a fresh snapshot if it's too old or the server restarted (a new `epoch`).
- **Your edits are optimistic:** shown immediately, then sent as `PATCH { changes, baseVersion }`.
  - If someone changed the task meanwhile (409) and **only other fields** → your edit is re-applied on top automatically.
  - If **the same field** → the server wins, your edit is undone, and the activity log and banner say so.
  - On network errors → undone, with an error.
- **One request per task at a time:** edits made while one is in flight are combined and sent next, with the new version.

### How a change flows
```
You change a status in the list
  → store.updateTask: reducer shows it immediately (pending)    → every view re-renders once
  → PATCH /api/tasks/:id {changes, baseVersion}
  → server: version+1, broadcasts task.updated to every browser
  → your browser: HTTP answer confirms it; the SSE echo has the same version → ignored
  → other browsers: SSE event is newer → applied → their views re-render once
```

## Edge cases

| # | Edge case | Handling | Test |
|---|---|---|---|
| 1 | Edit in any component | One store update; every subscribed view re-renders in the same render | app |
| 2 | Derived data out of sync | Never stored; memoized selectors; property test over 3,000 random operations | selectors |
| 3 | Your edit and a server change on the same task | 409 → automatic rebase if different fields, else roll back + notice | store, reducer |
| 4 | Duplicate / out-of-order events | Applied only if the version (and seq) is newer | reducer |
| 5 | Your own change echoed back | Same version → ignored, no duplicate log entry | reducer |
| 6 | An update arriving after the delete | Deleted ids are remembered with their version; no resurrection | reducer |
| 7 | Connection drops | Reconnect with the last event id → replay; too old → snapshot | server, live |
| 8 | First load vs live updates | The snapshot is the first message of the same stream | server |
| 9 | Server restart (in-memory data reset) | New `epoch` → client replaces its state with the new snapshot | server, reducer |
| 10 | Selected task deleted remotely | Editor shows "This task was deleted"; no crash | app, store |
| 11 | Editing the title while it changes remotely | Your draft is kept, with a notice; other fields keep updating live | app, reducer |
| 12 | Network error / server down on a change | Undone, error banner, logged; badge shows the connection state | store, reducer |
| 13 | Rapid repeated edits to one task | One request at a time per task; later edits combined, sent with the new version | store |
| 14 | Invalid input (empty/invisible/too-long title, unknown person, extra fields) | Rejected in the form and by the server (400) | app, server |
| 15 | Create retried | The browser chooses the id; the same request again returns the existing task | server |
| 16 | Delete twice / already deleted | 204 either way | server |
| 17 | Burst of events (e.g. replay after reconnect) | Batched per frame (~16 ms) into one store update → one render | live, store, reducer |
| 18 | Activity log growing forever | Capped at 50 entries | reducer |
| 19 | Two tabs / two users | Both get every event; the log says "you", "another user" or "server" | reducer, server |
| 20 | Empty board | Zeros and empty-state messages | app, selectors |
| 21 | HTML in a title | Rendered as text by React, never as HTML | app |
| 22 | Simulator empties or floods the board | Task count kept within `SIM_MIN_TASKS`..`SIM_MAX_TASKS` | server |
| 23 | A very slow client | Its unsent backlog is capped; it's disconnected and catches up by replay, so server memory stays bounded | (code review) |
| 24 | You delete a task while its create is still in flight | The delete is sent as soon as the create succeeds: no orphan task on the server | store |
| 25 | An assignee unknown to this client (newer server) | Gets its own group, so the groups still add up to the total | selectors |
| 26 | Malformed stream message | Ignored; the stream keeps working | live |
| 27 | You delete a task while an edit to it is in flight | The edit's late answer is ignored: a deleted task never comes back | store |
| 28 | You click into the title and leave without changing it, after someone else renamed the task | Nothing is saved (only a real change is sent), so their rename is never overwritten | app |
| 29 | A board whose snapshot is larger than the slow-client limit | The limit only applies to live events piling up, so a large board can still connect | server |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `4000` / `127.0.0.1` | Where the server listens |
| `SIMULATOR` | `on` | `on` / `off`: random server-side changes |
| `SIM_INTERVAL_MS` | `4000` | Time between simulated changes |
| `SIM_MIN_TASKS` / `SIM_MAX_TASKS` | `4` / `20` | Bounds the simulator keeps the task count within |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` |

Invalid values stop the server at startup with a clear message.

## Project structure

```
shared/types.ts        contract shared by server and browser (Task, events, validation rules)
server/                Fastify mock server
  taskStore.ts         in-memory tasks, versions, event sequence, replay buffer
  routes.ts            REST: create / update (409 on stale version) / delete
  events.ts            SSE stream: snapshot, live events, replay, heartbeat
  simulator.ts         random changes within bounds
  app.ts / index.ts    wiring / entrypoint (config, graceful shutdown)
src/
  state/reducer.ts     pure state transitions (the shared-state logic)
  state/selectors.ts   derived data, memoized
  state/store.ts       Zustand store: state + actions + one request per task
  state/useBoard.tsx   React hook/provider for subscribing to slices
  api/http.ts          REST calls with typed results
  api/live.ts          SSE connection: batching, reconnect
  components/          the five views + form + connection badge
tests/                 reducer, selectors, store, live, server, app (React Testing Library)
```

## What is implemented
All requirements: five synchronized views; edit from the **list** (status, delete), the **editor** (every field) and the **person view** (status, reassign: the task moves to the other person's group everywhere at once); the summary and activity log are read-only by nature; add and delete; random server-side changes over SSE reaching every view; derived data that can't go stale; 97 automated tests for the shared-state logic, the server and the UI.

## What is left out (and why)
| Left out | Why |
|---|---|
| Persistence | The assignment allows in-memory; data resets to sample tasks on restart (handled correctly by the client, #9). |
| Authentication / real users | Out of scope; each browser tab gets a random client id, used only to label "you" vs "another user". |
| Field-level merge of concurrent title edits | Last-writer rules per field (with rebase) are enough here; real-time co-editing of text would need CRDTs/OT. |
| Undo/redo, filtering, drag-and-drop | Not required; the state design (pure reducer) would make undo straightforward to add. |
| Browser end-to-end tests (Playwright) | Behavior is covered with React Testing Library in jsdom plus real-HTTP server tests; a browser runner would add setup time. |
