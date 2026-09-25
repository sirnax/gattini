# Gattini

Gattini is a local-first tool in early development for coordinating AI coding agents through durable jobs, runtime adapters, and verifiable results. The initial target is a macOS CLI and daemon; OpenCode is the first worker runtime to investigate.

**Project status: durable fake jobs, an initial OpenCode review path, and tested cancellation/recovery.** This repository has a strict TypeScript package, a local CLI and daemon, one approved live OpenCode V2 read-only review, and one approved live exact-session cancellation. Crash reconciliation has passed fake-runtime process-kill tests. Checkpoint 2 awaits human review before coding worktree development. Results report acceptance as `unverified` until independent verification exists.

## Project documents

- [Master plan](docs/roadmaps/GATTINI_MASTER_PLAN.md) — product goals, architecture, safety boundaries, and decisions to validate.
- [Implementation roadmap](docs/roadmaps/GATTINI_ROADMAP.md) — sequenced tasks, acceptance criteria, and review checkpoints.

The roadmap is the authoritative task list. Runtime discovery and Task 3's bounded live OpenCode probes are recorded in [the compatibility inventory](docs/compatibility.md). Do not assume proposed Gattini commands or integrations already exist.

## Development

Use Node 24 or newer. The installed Node 24 and 26 versions have both been checked.

```sh
npm ci
npm run build
npm run typecheck
npm test
```

`npm test` runs offline fake-runtime, daemon, CLI, role mapping, and OpenCode adapter tests. It does not contact a model provider or exercise a live OpenCode service. The contracts are in [`src/core/contracts.ts`](src/core/contracts.ts), with the fake adapter in [`src/adapters/fake.ts`](src/adapters/fake.ts).

To try the durable fake slice, build the project, then run the daemon in one terminal and the CLI in another:

```sh
node dist/src/daemon/gattinid.js
node dist/src/cli/gattini.js start --task-file task.txt --idempotency-key example-1 --json
node dist/src/cli/gattini.js status JOB_ID --json
node dist/src/cli/gattini.js result JOB_ID --json
```

`task.txt` is a UTF-8 task description. The fake job completes without a provider and reports acceptance as `unverified`. Local state defaults to `~/Library/Application Support/Gattini`; set `GATTINI_STATE_DIR` to an absolute private directory to isolate a disposable run. The daemon is started manually and does not register a login service. See [ADR 004](docs/decisions/004-durable-fake-slice.md) for persistence and restart behavior.

The `reviewer` role uses a private `roles.json` in the state directory. It pins a named OpenCode agent, exact model, working directory, loopback service address, and deny-all/read-only permission rules. The daemon attaches to an already-running OpenCode 2.0.16 service; it does not start or stop that shared service. Use `--role reviewer` with `start` only after configuring that file. See [ADR 005](docs/decisions/005-durable-opencode-review.md) and the [compatibility report](docs/compatibility.md) for the tested path and limits.

`gattini cancel JOB_ID --json` requests cancellation of a reviewer job. A queued job with no runtime attempt is cancelled immediately. A running job is marked `cancelled` only when its exact OpenCode session is inactive and reports interruption; otherwise it remains `interrupted` and blocks another review in the same directory until reconciliation. See [ADR 006](docs/decisions/006-cancellation-and-recovery.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to propose and record changes.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
