# How I used AI tools

I used **Claude Code** (Anthropic's AI coding assistant, running in my terminal) as a pair programmer for both tasks. I made the decisions and reviewed the work; the AI did most of the typing, proposed options, and was used heavily for reviewing and testing.

## What I decided

Before any code was written, I had the AI lay out the options with trade-offs, and I chose:

- **Stack:** TypeScript + Fastify for Task 1 (the same language as the React app in Task 2).
- **Quota algorithm:** a fixed window. I had it compare the alternatives (sliding window, token bucket, leaky bucket) and write down why a fixed window fits a *billing* quota best.
- **Failed AI calls:** not charged, but recorded as evidence.
- **Unknown users:** 200 with zeros rather than 404, since there is no user registry.
- **Structure:** feature modules with layers (routes → service → repository). I rejected the first, more fragmented version as too many files for the scope and chose a leaner one.
- **Storage:** SQLite, with the schema kept in code rather than in a separate `.sql` file.
- **Task 2:** Zustand + Server-Sent Events, a Fastify mock server, in-memory data, plain CSS.
- **Design document:** Mermaid diagrams, with a slot for a Lucidchart image.

I also raised questions that changed the design. For example: what happens to two users whose requests fall at different times in the same period, and what `GET /usage/events` returns with no filters. The second led to defined defaults and cursor pagination.

## What the AI did

- Planned both tasks in plan mode; I reviewed and approved each plan before any code was written.
- Brainstormed edge cases. Each one is documented with how it's handled and, where practical, has a test: 45 for Task 1 and 29 for Task 2.
- Wrote the code, the tests and the documentation.
- Before creating each file, gave me a short explanation of what it does and why it matters, so I approved files knowing their purpose rather than in bulk.

## How the output was checked

- **Repeated code reviews.** I asked for a full review of each task, then for fixes and another review, until a round came back with no comments: 7 rounds for Task 1 and 5 for Task 2. These reviews found real bugs, for example:
  - a crashed process exiting with code 0 ("success")
  - timer settings above Node's 32-bit limit silently becoming 1 ms (every request would time out)
  - the crash-recovery sweeper getting stuck on a corrupt counter row
  - a deleted task reappearing when a late server answer arrived
  - the editor overwriting someone else's title change when you only clicked into the field
  - a large board never being able to connect to the live stream
- **Every bug was reproduced first** (a failing test or a small probe), then fixed, and the test was kept so it can't come back.
- **Running it for real**, not just unit tests:
  - start-up from a clean copy without `node_modules`
  - real HTTP requests, including a 409 conflict
  - the live event stream read with `curl`
  - three separate processes sharing one database
  - the Task 2 board opened and watched in a browser
- **Type checking** in strict mode on every change.

## Mistakes the AI made that were caught

The AI was not always right the first time. Some tests had wrong expectations, and the code was right; those were corrected, not the code. Once, a PowerShell command it used to edit files corrupted a few non-ASCII characters (like `✕`). It noticed, fixed them, checked both tasks for any other damage, and added a UI test that checks those characters. Reviewing and running everything, rather than trusting the first output, is why these were caught.

## Responsibility

I can explain every part of the submission: the design decisions above, how each edge case is handled, and how the code is structured. The trade-offs and what was left out are written down in each task's README and in Task 1's design document.
