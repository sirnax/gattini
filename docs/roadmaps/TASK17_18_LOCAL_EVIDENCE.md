# Tasks 17–18 local evidence — 27 September 2026

Checkpoint 6 authorized local extension development. This work started from clean `main` at `07e99749ec04280de3b6983bcc7b412ff31528ea`. The primary owned protocol, daemon, store, CLI, integration and verification; a GPT-6 Sol medium worker owned only `extension/**` with no nested delegation. No provider call, tap/extension publication, push, merge, startup service or normal-account install occurred. The direct-edit gate stayed disabled.

## Contract and behavior

Release `0.2.0` speaks protocol v2. The CLI and extension send `hello` before job calls and require the exact daemon release and protocol. Direct legacy v1 calls remain limited to v1 methods; v2-only calls reject v1. `events.list` returns at most 100 redacted events after an exclusive monotonic sequence, with `nextSequence` and `hasMore`. Empty pages preserve the cursor. Unknown jobs, malformed or future cursors, and gaps produce typed errors. The client persists the last fully processed cursor and rejects missing sequences. `evidence.read` takes exact job/optional attempt IDs and a diff or snapshot kind, checks retained digests, limits artifact reads to 64 KiB, and returns no artifact path. Snapshot output is metadata, not snapshot contents.

The extension does not schedule jobs or hold runtime configuration or the job database. It submits the fake `code` role, stores IDs/cursors in VS Code workspace state, resumes polling, requires Workspace Trust for submit/attach/actions, and asks for a folder in a multi-root workspace. Output is plain text with bounded formatting; no webview, HTML interpolation or diagnostic export exists. Approve/deny refresh exact approval and job state, then use the exact approval ID; cancellation uses the exact saved job ID and refreshes status.

## Offline gates

Commands ran from the repository root. Local Unix-socket fixture access was automatically reviewed and allowed. The test runner was serialized to avoid interference among daemon lifecycle fixtures.

| Runtime | Exact command | Result |
| --- | --- | --- |
| Node 24.21.0 root | `env PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck && env PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build && env PATH=/opt/homebrew/opt/node@24/bin:$PATH node --test --test-concurrency=1 dist/tests/*.test.js > /private/tmp/gattini-task18-node24.log 2>&1` | Pass, 202/202 |
| Node 26.10.0 root | `npm run typecheck && npm run build && node --test --test-concurrency=1 dist/tests/*.test.js > /private/tmp/gattini-task18-node26.log 2>&1` | Pass, 202/202 |
| Node 24.21.0 extension | `env PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck --prefix extension && env PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build --prefix extension && env PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test --prefix extension` | Pass, 8/8 |
| Node 26.10.0 extension | `npm run typecheck --prefix extension && npm run build --prefix extension && npm test --prefix extension` | Pass, 8/8 |

An initial parallel root `npm test` attempt exposed a hardcoded `0.1.0` expectation in the package lifecycle test and did not complete. That expectation was updated for `0.2.0`; both final serial gates above passed. `git diff --check` passed. The disposable VS Code 1.115.0 extension-host smoke activated the extension and executed `gattini.showJobs` and checked registration of `gattini.attachJob`. Its final exact command was:

```sh
env GATTINI_HOST_TEST_MARKER=/private/tmp/gattini-vscode-host.83BQSu/host-pass-attach.txt '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' --user-data-dir=/private/tmp/gattini-vscode-host.83BQSu/user --extensions-dir=/private/tmp/gattini-vscode-host.83BQSu/extensions --extensionDevelopmentPath=/Users/nathanlord/VS/gattini/gattini/extension --extensionTestsPath=/Users/nathanlord/VS/gattini/gattini/extension/test/host-runner.cjs --disable-telemetry --new-window
```

It exited 0 and wrote the pass marker. The directories were disposable; nothing was installed in the normal VS Code profile.

## Manual local checks

- In a disposable VS Code development host and workspace path containing spaces, **Gattini: Submit Task** created fake job `c5251dc6-2ed3-4384-a52a-398733d79472`. The output showed event sequences 1–3 and `completed`. **Show Result** showed the fake result and `unverified` acceptance. CLI `status`, `events` and `result` agreed. After daemon restart, the editor still showed that result. While disconnected, the output showed `DAEMON_UNAVAILABLE`.
- The CLI created reviewer job `7f932369-eb01-453f-a3b4-8b5a1d1d813b` with approval `f4585804-ad4c-4510-8b4e-25348a7ecbb1`. **Deny Pending Action** in the disposable editor showed the exact approval, job and action; after denial, the CLI reported `failed`, no pending approval, and zero reviewer attempts. This was an offline approval check without a provider launch.
- A separate disposable source repository and fake `opencode` executable created guarded code job `1a0032f7-dbe5-4d4c-a9d3-edf41885647e`. Its launch and apply approvals were granted through the CLI. It completed with passed acceptance and verified snapshot for attempt `2853da2c-1049-40cc-974b-dbbc1310fd34`. After daemon restart, the extension client read `evidence.read` diff text containing `+new` and snapshot metadata listing `code.txt`; no artifact path was exposed. **Attach Existing Job** in a disposable editor bound that exact CLI job and **Show Result** displayed passed acceptance, `code.txt`, and the verification exit code.

The manual evidence command was opened but its diff/snapshot selection was not completed in the VS Code UI. The user asked about the unexpected VS Code window at that point, so the disposable window and daemon were closed. Task 18 remains open for that visible check; the protocol and extension client evidence paths have offline and real-daemon coverage. No derivative editor was tested, and native compatibility is not inferred from VS Code compatibility. The fake provider fixture does not prove a live provider boundary, and a local child exit would not prove remote computation cancellation. Checkpoint 7 remains pending, including Task 16 local validation and human publication/deferral and release decisions.
