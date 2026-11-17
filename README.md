# Developer Home Assignment

Two independent tasks, each in its own folder with its own dependencies, tests and README.

| Task | What it is | Folder |
|---|---|---|
| **1. AI Usage Metering & Quota System** | A service that meters AI requests per user, enforces a configurable quota per period, and records every credit used as tamper-proof evidence. Includes the design document. | [`task1-metering/`](task1-metering/) |
| **2. Shared-State Team Task Board** | A React task board where five components show the same data and stay in sync, with a mock server pushing random changes live. | [`task2-taskboard/`](task2-taskboard/) |

📄 **Task 1 design document:** [task1-metering/docs/DESIGN.md](task1-metering/docs/DESIGN.md)
🤖 **How I used AI tools:** [AI_USAGE.md](AI_USAGE.md)

## Requirements

**Node.js 20.19 or newer.** Nothing else: no database server, no Docker. Task 1 uses SQLite embedded through an npm package; Task 2 keeps its data in memory.

## Run

Each task starts with one command (it installs its own dependencies first):

```bash
cd task1-metering
npm start          # API on http://127.0.0.1:3000
```

```bash
cd task2-taskboard
npm start          # open http://127.0.0.1:4000 (try two browser tabs)
```

## Test

```bash
cd task1-metering && npm test    # 95 tests
cd task2-taskboard && npm test   # 97 tests
```

Both also have `npm run typecheck` (TypeScript strict mode).

## Where to look

| | Task 1 | Task 2 |
|---|---|---|
| How to run, API, config, what's implemented / left out | [README](task1-metering/README.md) | [README](task2-taskboard/README.md) |
| Design and decisions | [DESIGN.md](task1-metering/docs/DESIGN.md) | [README: state management and why](task2-taskboard/README.md#state-management-the-approach-and-why) |
| Edge cases | [EDGE_CASES.md](task1-metering/docs/EDGE_CASES.md) (all 45; summarized in DESIGN.md §4) | [README: edge cases](task2-taskboard/README.md#edge-cases) (29) |
| Core logic | `src/modules/quota/`, `src/modules/usage/` | `src/state/reducer.ts`, `src/state/selectors.ts` |

## Tech stack

TypeScript (strict) throughout. **Task 1:** Fastify, SQLite (better-sqlite3), Vitest. **Task 2:** React, Zustand, Vite, Fastify (mock server), Server-Sent Events, Vitest + React Testing Library.
