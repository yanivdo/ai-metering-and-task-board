# Task 1: AI Usage Metering & Quota System

Every AI request uses one credit, every credit is stored as evidence, and each user may make at most **X** requests per period (configurable).

📄 **Design document:** [docs/DESIGN.md](docs/DESIGN.md) · **All edge cases:** [docs/EDGE_CASES.md](docs/EDGE_CASES.md)

## Run it

Requirements: **Node.js 20+**. Nothing else: SQLite is embedded via the `better-sqlite3` npm package, and the database is a local file created on first start.

```bash
cd task1-metering
npm start
```

`npm start` installs dependencies (fast when already installed) and starts the server on `http://127.0.0.1:3000`.

```bash
npm test          # all automated tests
npm run typecheck # TypeScript strict type check
```

## API

| Method & path | What it does |
|---|---|
| `POST /v1/users/:userId/ai-requests` | Make an AI request. Body `{"prompt": "..."}`. Optional header `Idempotency-Key`. |
| `GET /v1/users/:userId/usage` | Current period: `limit`, `used`, `inFlight`, `remaining`, `periodStart`, `periodEnd`. |
| `GET /v1/users/:userId/usage/events?limit=&cursor=` | Usage evidence, newest first (default 50, max 100), cursor-paginated. |
| `GET /health` | Liveness + database check. |

**Responses for `POST /ai-requests`**

| Status | Meaning | Charged? |
|---|---|---|
| 200 | AI answered | yes |
| 400 | Invalid input | no |
| 409 | Same `Idempotency-Key` still in progress | no |
| 422 | `Idempotency-Key` reused with a different prompt | no |
| 429 | Quota exhausted (`Retry-After` = seconds until reset) | no |
| 502 | AI provider failed (recorded as evidence) | no |
| 503 | Storage unavailable (fail closed) or request interrupted | no |
| 504 | AI provider timed out (recorded as evidence) | no |

### Examples

PowerShell:
```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/v1/users/alice/ai-requests `
  -ContentType 'application/json' -Body '{"prompt":"hello"}' -Headers @{ 'Idempotency-Key' = 'req-1' }
Invoke-RestMethod http://127.0.0.1:3000/v1/users/alice/usage
Invoke-RestMethod http://127.0.0.1:3000/v1/users/alice/usage/events
```

curl:
```bash
curl -X POST http://127.0.0.1:3000/v1/users/alice/ai-requests \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: req-1' -d '{"prompt":"hello"}'
curl http://127.0.0.1:3000/v1/users/alice/usage
curl http://127.0.0.1:3000/v1/users/alice/usage/events
```

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `QUOTA_LIMIT` | `10` | X: max charged requests per user per period (`0` blocks everything) |
| `QUOTA_PERIOD_SECONDS` | `3600` | Length of the fixed window (same windows for all users) |
| `AI_MIN_DELAY_MS` / `AI_MAX_DELAY_MS` | `100` / `1500` | Simulated AI latency range |
| `AI_FAILURE_RATE` | `0.1` | Probability (0–1) that the simulated AI fails |
| `AI_TIMEOUT_MS` | `3000` | Hard timeout for the AI call |
| `RESERVATION_TTL_MS` | `30000` | Reservations older than this are treated as abandoned (must be > `AI_TIMEOUT_MS`) |
| `SWEEP_INTERVAL_MS` | `10000` | How often the crash-recovery sweeper runs |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Graceful-shutdown deadline; after it the process force-exits with code 1 |
| `MAX_PROMPT_CHARS` | `4000` | Maximum prompt length |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Where the server listens |
| `DB_PATH` | `./data/metering.db` | SQLite file location |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` |
| `REQUEST_HASH_SECRET` | local dev value | Secret for HMAC-hashing prompts (min 16 chars). **Set it in production**; a warning is logged if the default is used |
| `DB_SYNC` | `FULL` | `FULL`: a committed credit survives a power loss. `NORMAL`: lower latency, survives app crashes |

Invalid values stop the server at startup with a clear message. Millisecond settings are capped at 2,147,483,647 (Node's timer limit) and `QUOTA_PERIOD_SECONDS` at 10 years. PowerShell example: `$env:QUOTA_LIMIT='3'; npm start`

## Project structure

```
src/
  config/env.ts               configuration + validation
  modules/usage/              AI requests, usage endpoints, evidence ledger (routes → service → repository)
  modules/quota/              fixed-window quota, reserve/commit/release, crash-recovery sweeper
  infrastructure/database.ts  SQLite setup, schema, tamper-proof triggers, transactions
  infrastructure/mock-ai.ts   simulated AI (random delay + failures + cancellation)
  shared/                     errors + error handler, logger interface, clock and period math
  app.ts / server.ts          wiring / entrypoint
  shutdown.ts                 graceful shutdown: exit codes and deadline
tests/                        quota, API, idempotency, concurrency (incl. 3 OS processes), shutdown
docs/DESIGN.md                design document (Part A)
docs/EDGE_CASES.md            all 45 edge cases (appendix to the design document)
```

## What is implemented

- Per-user quota with a **fixed window**; atomic check-and-reserve, so concurrent requests (and multiple processes on the same DB) can never exceed X.
- **Reserve → call AI → commit/release:** only successful calls are charged; failures and timeouts are recorded but not charged.
- **Append-only evidence ledger** with DB triggers that block deletes and illegal edits; only an HMAC of the prompt is stored.
- **Idempotency keys:** retries never double-charge.
- Hard AI timeout, batched crash-recovery sweeper, fail-closed (503) when storage is unavailable.
- Graceful shutdown with a deadline; exit code 1 after a crash so a supervisor notices.
- Usage endpoint and paginated evidence endpoint.
- 95 automated tests covering the 45 edge cases listed in [docs/EDGE_CASES.md](docs/EDGE_CASES.md) (summarized in the design document).

## What is left out (and why)

| Left out | Why |
|---|---|
| Authentication | Out of scope; the user id comes from the URL. In production it would come from auth (unknown caller → 401). |
| Per-user limits / plans, admin API | One global X keeps the scope focused; design: a `user_limits` table read in the same transaction. |
| Circuit breaker for the AI | The timeout already bounds latency; described in the design as a production addition. |
| Postgres / Redis deployment | The assignment asks for local storage only; the design explains the production version. |
| Calendar-month periods | The window is a fixed number of seconds; calendar months need date math. |
| Client-disconnect test | Behaviour is documented (the request still finalizes); hard to simulate reliably with in-process tests. |
