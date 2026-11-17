# How I used AI tools

I used **Claude Code** (Anthropic's AI coding assistant, running in my terminal) as a pair programmer. **I planned the solution, defined the test plan and led the reviews**; the AI implemented most of the code from my plan and extended the tests with additional edge cases.

## Planning: done by me

I broke down the assignment and planned both tasks before any code was written:

- **Architecture and approach.** Task 1: TypeScript + Fastify, SQLite as local storage, a fixed-window quota, and reserve → call AI → commit/release. Task 2: React with a single Zustand store, Server-Sent Events from a Fastify mock server, and in-memory data.
- **Key decisions:**
  - failed AI calls are **not charged but recorded** as evidence
  - unknown users get 200 with zeros rather than 404
  - a fixed window was chosen over sliding window and token bucket, because this is a billing quota
  - each task is self-contained in its own folder
- **Structure.** Feature modules with layers (routes → service → repository). I rejected the first, more fragmented layout as too many files for the scope and chose a leaner one.
- **Priorities.** Edge cases first, low latency, and code at a senior level that I can explain line by line.
- **Design questions** that shaped the solution, for example how users whose requests fall at different times in the same period are counted, and what the usage-history endpoint returns with no filters (this led to defaults and cursor pagination).

I used the AI to lay out alternatives and their trade-offs, then made the choice myself.

## Test plan: defined by me, extended by the AI

I defined what had to be tested: the quota limit, concurrency (including several server instances sharing one database), retries and idempotency, AI failures and timeouts, crash recovery, period boundaries, input validation, and for Task 2 that every component stays in sync, including changes coming from the server.

The AI wrote the tests from that plan and **added more edge cases on top of it**, for example:
- timer settings beyond Node's 32-bit limit
- prompts made only of invisible characters
- a deleted task reappearing after a late server answer
- a large board unable to connect to the live stream

All edge cases are documented with how each is handled: 45 for Task 1 (`task1-metering/docs/EDGE_CASES.md`) and 29 for Task 2 (its README).

## Reviews: led by me

- I reviewed each file as it was created (with a short explanation of its purpose).
- **After each code review, the AI reported its findings to me**: bugs (each reproduced first), new edge cases and duplicated code. **I went through them and decided what to fix and how**; only then were the fixes made.
- I **required another full review after every round of fixes, until a round came back with no comments**: 7 rounds for Task 1 and 5 for Task 2.
- These rounds found and fixed real bugs, for example:
  - a crashed process exiting with code 0 ("success")
  - the crash-recovery sweeper getting stuck on a corrupt row
  - the editor overwriting someone else's title change when you only clicked into the field
- I checked both tasks against the assignment's requirements myself. That caught a design document longer than the 2–4 pages asked for, and an assignee view that didn't yet allow editing. Both were fixed.

## What the AI did

- Wrote most of the code, tests and documentation, following my plan.
- Proposed alternatives with trade-offs when I asked.
- Added extra edge cases and tests beyond my test plan.
- Ran the code reviews I asked for, and reproduced every bug before fixing it (a failing test or small probe that is kept as a regression test).

## Verification

- Every change was type-checked (strict mode) and tested: 95 tests for Task 1 and 97 for Task 2.
- Both tasks were run for real, not just through tests:
  - start-up from a clean clone of the GitHub repository
  - real HTTP requests, including a 409 conflict
  - the live event stream read with `curl`
  - three processes sharing one database
  - the task board checked in a browser

## Responsibility

I can explain every part of the submission: the design decisions, how each edge case is handled, and how the code is structured. Trade-offs and what was left out are documented in each task's README and in Task 1's design document.
