# Gate C technical review — 28 September 2026

## What the gate needs to prove

Gate C asks whether the macOS CLI can be installed and recovered, and whether the local VS Code client and CLI use the daemon's same durable jobs and approval state. A newly created macOS login account is an indirect way to test installation. The relevant risks are package/dependency resolution, command discovery, private state creation, recovery, and cross-client agreement. The owner's iMac test exercised a fresh Gattini and Node 24 installation through the public tap in a normal Homebrew account. A separate disposable recovery run exercised the published archive. Creating another macOS user on the development Mac would mainly retest that user's Homebrew ownership. **No newly created macOS account was tested or claimed.** The owner challenged treating that extra account as a blocker after the separate-iMac test and had directed the agent to complete testing and sign-off when evidence sufficed. The gate now tests the supported installation path instead of account provisioning.

## CLI and editor share jobs

The [Tasks 17–18 record](TASK17_18_LOCAL_EVIDENCE.md) documents three manual, disposable VS Code flows: an editor-submitted job whose exact ID, events and result matched the CLI after daemon restart; a CLI-created approval that the editor denied and the CLI then observed as failed with no reviewer attempt; and a CLI-created guarded fake-code job that the editor attached and displayed with passed result, verified diff and snapshot metadata after restart. The CLI's `result` shows result and verification evidence; the editor's bounded `evidence.read` view shows diff text or snapshot metadata. These are deliberately different presentations of the same daemon record. The CLI does not have a `gattini evidence` command and identical diff rendering is not a Gate C requirement.

Current offline extension checks were repeated without opening a VS Code window:

```sh
env PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck --prefix extension
env PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build --prefix extension
env PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test --prefix extension
npm run typecheck --prefix extension
npm run build --prefix extension
npm test --prefix extension
```

Node 24.21.0 and Node 26.10.0 each passed typecheck, build and **9/9** extension tests, including a real daemon/CLI shared-job and cursor-recovery test. Logs: `/private/tmp/gattini-gate-c-extension-node24.log` and `/private/tmp/gattini-gate-c-extension-node26.log`. Earlier disposable extension-host and manual display results remain the UI evidence; this repeat was headless.

## Installation and recovery

The [Task 16 public tap record](TASK16_TAP_PUBLICATION.md) documents the owner-supplied iMac install, offline fake job, formula test, service stop and uninstall. Node 24.21.0 was installed as a fresh Homebrew dependency and removed as unneeded after Gattini uninstall. The iMac transcript did not capture each command's exit code separately or run recovery there.

The public `v0.2.0` archive was checked against SHA-256 `97ab34442ff72130333945ff177ff82a82c78a469da050ff1f818d0cc027e06f`, then installed offline into a disposable prefix with Node 24. The installed daemon completed fake job `dfb484db-8f51-42c7-8b0b-a5500712bde5` in a private state path with spaces. After clean daemon stop, the state was copied. The guide's `zsh` restore commands first rejected a missing backup without moving state, then moved the original aside and restored the backup with mode `0700`. A restarted daemon returned the same completed job and result, with event sequences `[1,2,3]`; disposable npm uninstall removed the command. The backup database SHA-256 was `e9eeb247ad02762b685e480cf692022567891d96a06f763b5896a3702d319cfa`. Exact runner: `/private/tmp/gattini-gate-c-recovery.mjs`; shell block: `/private/tmp/gattini-gate-c-restore.zsh`; machine report: `/private/tmp/gattini-gate-c-recovery-report.json`. Command `node /private/tmp/gattini-gate-c-recovery.mjs` exited **0**. No provider, normal-account install or startup service was used in this recovery test.

The first-use example in [the installation guide](../installation.md) was missing creation of its task file. The source guide now creates that file and gives concrete state-restore commands; the shell restore block was executed with disposable paths and a missing-backup preflight. The immutable public 0.2.0 archive still contains the older guide and a CLI that prints “Unknown command” for `--help`; these source fixes require a future patch release to reach Homebrew installations. The archive's job commands and recovery behavior passed the checks above. **The corrected source guide must not be described as shipped in 0.2.0.**

## Decision boundary

The shared-job criterion is supported. The public macOS package installed on a second Mac and the published archive recovered private state in a disposable run. Gate C accepts that direct evidence in place of creating a new macOS login account; the owner had instructed the agent to sort, test and sign off when ready, and then reaffirmed the iMac install/run result. The public 0.2.0 archive's older first-use guide and `--help` behavior remain recorded limitations for a future patch. **Gate C is signed off within the public macOS CLI/Homebrew and local VS Code scope.** The VS Code extension remains a local development build; no VSIX or Marketplace publication, Linux release, Windows support, paid provider test, startup service or direct-edit capability is implied. The owner's platform order makes Debian/Ubuntu Linux distribution the next milestone, then Windows; each still needs its own plan and release approval.
