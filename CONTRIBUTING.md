# Contributing

Gattini is in early development. Read the [master plan](docs/roadmaps/GATTINI_MASTER_PLAN.md) and [implementation roadmap](docs/roadmaps/GATTINI_ROADMAP.md) before proposing implementation work.

## Working agreements

- Work on the next unchecked roadmap task and meet its acceptance criteria.
- Keep the roadmap as the single task checklist; add evidence and verification outcomes when a task is complete.
- Preserve existing local agents, credentials, and unrelated user changes.
- Validate runtime versions, model IDs, and capabilities instead of assuming them.
- Do not install software, publish packages, enable startup services, or run live paid jobs without the project owner's approval.
- Keep pull requests focused. Explain behavior changes, evidence, limitations, and any roadmap updates.

## Local checks

On Node 24 or newer, run `npm ci`, `npm run typecheck`, and `npm test`. These currently cover only the offline contract prototype. Report real-runtime checks separately, with version, model, permissions, and spend evidence.
