# Task 1: All Edge Cases (appendix to [DESIGN.md](DESIGN.md))

Every edge case found while designing, building and reviewing Task 1, with how it's handled and whether it has an automated test. The design document (§4) summarizes the most important ones; the numbers here are the ones used in the design document and in code comments (e.g. `#9`).

Legend: ✅ automated test · 📐 design only (production)

| # | Edge case | Handling | Test |
|---|---|---|---|
| 1 | Concurrent requests with 1 credit left | Atomic conditional reserve; exactly one wins, others 429 | ✅ |
| 2 | Several instances on one DB | Lock is in the DB, not in memory; tested with 3 OS processes | ✅ |
| 3 | Client retries | `Idempotency-Key` → replay, charged once | ✅ |
| 4 | Same key, different body | 422 `IDEMPOTENCY_KEY_REUSED` | ✅ |
| 5 | Same key while still running | 409 `REQUEST_IN_PROGRESS` | ✅ |
| 6 | AI fails | `failed`, not charged, recorded | ✅ |
| 7 | AI hangs | Hard timeout (abort + race) → 504, credit released | ✅ |
| 8 | Crash between reserve and finalize | Sweeper expires reservations older than the TTL and returns the credit; row kept | ✅ |
| 9 | AI succeeds after the sweeper expired it | Charged (`expired → succeeded`): the user got the answer | ✅ |
| 10 | Request exactly on a boundary | One server timestamp at reserve; end exclusive | ✅ |
| 11 | Request in flight across a boundary | Charged to the period it was reserved in | ✅ |
| 12 | X lowered below usage | `remaining = max(0, …)`; new requests blocked; history untouched | ✅ |
| 13 | X raised mid-period | Applies on the next request | ✅ |
| 14 | X = 0 | Everything 429; AI never called | ✅ |
| 15 | Invalid config | Fails at startup with a clear message (incl. TTL ≤ AI timeout) | ✅ |
| 16 | Invalid input (user id, empty/whitespace/oversized prompt, wrong types, extra fields, bad key, bad JSON) | 400 before any credit is touched | ✅ |
| 17 | Unknown user | 200 with zeros. There is no user registry; in production identity comes from auth, so an unknown caller gets 401 📐 | ✅ |
| 18 | Ledger tampering | DB triggers abort the change | ✅ |
| 19 | Counter drifts from ledger | Same-transaction writes + invariant test | ✅ |
| 20 | Client clock wrong / instance clock skew | Only server time is used; 📐 at scale use the DB's clock | partial |
| 21 | Client disconnects mid-call | Request still finalizes and is recorded (charged if the AI succeeded) | documented |
| 22 | DB down / locked | `busy_timeout`, then 503: fail closed | ✅ |
| 23 | Shutdown with in-flight requests | Graceful close waits for them (responses sent with `Connection: close`, see #35); leftovers fixed by the startup sweep | ✅ |
| 24 | Events history: no filters, huge history, paging while new rows arrive | Default 50 newest; keyset cursor (no `OFFSET`); limit 1–100 else 400 | ✅ |
| 25 | User starts late in a period | Still gets X, but only until the shared reset (inherent to fixed windows) | by design |
| 26 | `QUOTA_PERIOD_SECONDS` changed between restarts | Windows realign; counters are keyed by `period_start`, so users effectively get a fresh window. Old evidence unchanged | documented |
| 27 | X = 0: `Retry-After` would be misleading (waiting doesn't help) | 429 **without** `Retry-After`, message says the quota is 0 | ✅ |
| 28 | Prompt hash reveals identical prompts across users / short prompts can be guessed | HMAC-SHA256 keyed by `REQUEST_HASH_SECRET` and including the user id; secret validated at startup, warning if the default is used | ✅ |
| 29 | Idempotency key reused much later (e.g. next period) | Replays the original result, no new charge: keys never expire, because the ledger is append-only. 📐 In production keep keys in a separate store with a 24-hour expiry | ✅ |
| 30 | Key whose request crashed mid-way | 409 until the sweeper expires it (up to TTL + sweep interval), then replays as interrupted (503, not charged). The safe choice: never run the same key twice while the first might still finish | ✅ |
| 31 | User ids differing only in case (`Alice` vs `alice`) | Treated as different users: ids are opaque, case-sensitive identifiers. 📐 In production ids come from auth, so clients can't invent variants | ✅ |
| 32 | Emoji / non-Latin characters: validator counts characters, `.length` counts UTF-16 units | `prompt_chars` counts Unicode code points, the same as the validator | ✅ |
| 33 | Sweeper after a long outage with thousands of stuck reservations | Expires them in batches of 500, each its own short transaction, so the write lock is never held long | ✅ |
| 34 | Synchronous SQLite blocks Node's event loop while waiting for the disk | Configurable `DB_SYNC`: `FULL` (default, survives power loss) or `NORMAL` (much lower latency, survives app crashes). 📐 Production uses an async Postgres driver | ✅ config |
| 35 | Shutdown delayed by idle keep-alive connections after in-flight requests finish | While closing, responses carry `Connection: close`, so clients drop the connection and shutdown completes right away | ✅ |
| 36 | Process crashes (uncaught exception) | Graceful shutdown, then **exit code 1**, so a supervisor (Docker, systemd, Kubernetes) sees the failure and restarts/alerts. Normal SIGINT/SIGTERM exits 0 | ✅ |
| 37 | Shutdown hangs (e.g. a stuck connection) | Hard deadline `SHUTDOWN_TIMEOUT_MS` (default 10 s), then force exit with code 1; leftover reservations are fixed by the startup sweep | ✅ |
| 38 | `MAX_PROMPT_CHARS` larger than the HTTP body limit | The body limit is derived from it (4 UTF-8 bytes per character + 1 KB), so every allowed prompt fits and nothing much larger is buffered | ✅ |
| 39 | Prompt made only of invisible zero-width characters | Rejected with 400: a prompt must contain at least one visible character | ✅ |
| 40 | AI answers after a period boundary: the credit is charged to the old period, but the response shows the new one (`used: 0`) | Deliberate: the response shows the current period, i.e. what the client can still do next; the evidence row records the charged period | documented |
| 41 | Counter row missing, or its `reserved` count already 0, when finalizing (a bug or a manual DB change) | Counter updates only apply when there is a reservation to settle and must change exactly one row; otherwise the transaction rolls back (500, logged), so a success is never recorded without being counted. The sweeper logs and continues, so one bad row can't block recovery | ✅ |
| 42 | Timer setting above Node's 32-bit limit (~24.8 days) | Node would silently use 1 ms (every AI call times out, sweeper runs every 1 ms, shutdown exits instantly). Timer settings are capped at 2,147,483,647 ms and the period at 10 years; larger values fail at startup | ✅ |
| 43 | Invalid `LOG_LEVEL` | Validated with the rest of the config: one clear message, exit 1 (no logger stack trace) | ✅ |
| 44 | Database file can't be opened (no permission, path is a directory, file isn't a database) | `DatabaseOpenError` naming the path; the server prints one clear line and exits 1 | ✅ |
| 45 | Server clock jumps (NTP correction, manual change) | Latency uses a monotonic clock. Record timestamps use the wall clock: a forward jump can make the sweeper expire a running request early (then charged late, #9); a backward jump can misorder history. 📐 In production take time from the database | documented |
