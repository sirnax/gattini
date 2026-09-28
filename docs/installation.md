# Install Gattini locally on macOS

This guide describes the local `gattini` 0.2.0 package for Apple Silicon (macOS arm64). The package is a versioned npm tarball; it is not published to npm or Homebrew. You need Node.js 24 or newer and its bundled npm. Install Node yourself using a source you trust. Gattini does not install or authenticate OpenCode, Codex, Claude Code, or any provider.

On the release builder's Apple Silicon Mac, from a Gattini source checkout with the locked development dependencies already installed, produce the tarball and checksum:

```sh
mkdir -p "$HOME/gattini-release"
node scripts/package-local.mjs --out-dir "$HOME/gattini-release"
```

For a fresh account, obtain `gattini-0.2.0.tgz` and its `.sha256` file from a trusted transfer, place both in `~/gattini-release`, then verify them before installing:

```sh
cd "$HOME/gattini-release"
shasum -a 256 -c gattini-0.2.0.tgz.sha256
```

The checksum detects accidental corruption when checked against a checksum obtained through a trusted channel; it does not authenticate a release by itself. The archive declares macOS arm64 and Node `>=24` and has no production npm dependencies. The local builder checks its exact locked TypeScript and Node type versions before compiling.

## Current distribution paths

| Component | Local artifact | Status |
| --- | --- | --- |
| CLI and daemon | `gattini-0.2.0.tgz` with checksum and `release.json` | Built byte-identically under Node 24 and 26 on Apple Silicon; disposable-prefix install tests passed. Not published. |
| Homebrew formula | Generated `gattini.rb` bound to the exact tarball checksum | Local draft only. A real tap URL, named-formula audit, `brew test`, and isolated Homebrew install/upgrade/uninstall remain open. |
| VS Code client | `extension/` source and compiled development host | Local extension-host and manual checks passed. No VSIX or Marketplace release has been prepared or installed into a normal profile. |

The verified package targets macOS arm64. A Debian/Ubuntu Linux build path is in preparation but has not yet run under Linux; see the [Linux guide](installation-linux.md). Intel macOS and Windows builds have not been validated. The editor client requires the matching `0.2.0` daemon and protocol v2; it does not contain or start the daemon.

## Install

The examples use a user-owned npm prefix at `~/.local`, so installation does not require administrator access. Add its `bin` directory to your `PATH` if it is not already there. For zsh:

```sh
mkdir -p "$HOME/.local"
npm install --global --prefix "$HOME/.local" "$HOME/gattini-release/gattini-0.2.0.tgz"
```

Add this line to `~/.zshrc` if needed, then open a new terminal:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Confirm the installed commands resolve from that prefix:

```sh
command -v gattini
command -v gattinid
npm list --global --prefix "$HOME/.local" --depth=0 gattini
```

The CLI and daemon come from the same package version. Do not run the CLI from one installation against a daemon left running from another version.

## Start and stop the daemon

Gattini currently uses a manually managed foreground daemon. In one terminal, start it:

```sh
gattinid
```

Leave that terminal open while using Gattini. In another terminal, submit and inspect a job, for example:

```sh
gattini start --task-file "$HOME/task.txt" --idempotency-key first-job --json
gattini status JOB_ID --json
gattini result JOB_ID --json
```

Replace `JOB_ID` with the ID returned by `start`. Press Control-C in the daemon terminal to stop it cleanly. The daemon handles SIGINT and SIGTERM and removes its socket as it closes. Do not force-quit it during a database write unless necessary; if it exits unexpectedly, inspect job state before resubmitting work.

By default, state lives in `~/Library/Application Support/Gattini`. The state directory contains durable job history, runtime role configuration, and retained evidence. It is private to your user. The daemon creates it with mode 0700 and the SQLite database and socket are private. To use a different location, set the same absolute `GATTINI_STATE_DIR` for both daemon and CLI processes:

```sh
export GATTINI_STATE_DIR="$HOME/Library/Application Support/Gattini-test"
gattinid
```

Set this variable in the client terminal too. Do not point multiple daemon instances at one state directory.

Login startup registration is not part of this installation. If a future release offers a launch service, enabling it must remain an explicit opt-in and it must run the installed version. This guide does not provide a service definition.

## Upgrade while preserving state

Before upgrading, finish or cancel active work where possible, then press Control-C in the daemon terminal and wait for it to exit. Keep a backup as described below. Install the new tarball over the existing user prefix:

```sh
npm install --global --prefix "$HOME/.local" "$HOME/gattini-release/gattini-NEXT_VERSION.tgz"
```

Start `gattinid` from the updated prefix and check existing jobs/configuration before submitting new work:

```sh
gattinid
gattini status JOB_ID --json
```

Gattini performs supported SQLite schema migrations when the daemon opens the database. Always retain a pre-upgrade backup until you have confirmed that the upgraded daemon starts and existing state can be read. Do not run an older daemon against a database already migrated by a newer release. If rollback is needed, stop the daemon first and restore the full pre-upgrade state backup before installing/running the older package.

## Back up and restore state

Stop the daemon before copying state so SQLite and its write-ahead log are captured consistently. The default path contains spaces, so quote it:

```sh
state="$HOME/Library/Application Support/Gattini"
backup="$HOME/Gattini-backup-$(date +%Y%m%d-%H%M%S)"
cp -a "$state" "$backup"
```

Keep backups private: they may contain task text, results, runtime configuration, and evidence. For a custom `GATTINI_STATE_DIR`, back up that directory instead. Retained code worktrees are recorded as job-owned directories and may be outside the state directory; preserve any such worktrees you still need separately. Gattini's cleanup preview is read-only and does not delete them.

To restore, stop the daemon, preserve the current directory under a different name if you may need it, then replace the state directory with the saved copy. Restore ownership to your account if the backup was moved from another account. Run `chmod 700 "$state"` on the restored directory and keep its files private; Gattini refuses a state directory accessible to other users. Start the daemon only after the restore is complete. Restore a full backup from one point in time; do not combine a database from one backup with evidence or configuration from another.

## Uninstall

Stop the daemon first. Remove the package from the same user prefix:

```sh
npm uninstall --global --prefix "$HOME/.local" gattini
```

This removes the installed CLI and daemon binaries. It does not remove `~/Library/Application Support/Gattini`, jobs, role configuration, retained evidence, backups, or separately located owned worktrees. Keep that data for a later reinstall, or remove it yourself only after reviewing what it contains. If you added the `PATH` line above, you may remove it from `~/.zshrc`.

## Verification status and limits

The package build, checksum, disposable user-prefix install/upgrade/uninstall, packaged fake job, version mismatch, and stopped-state migration backup/restore have offline tests on the Apple Silicon development Mac. The upgrade fixture starts from a locally fabricated `0.0.9` package because Gattini has no previous published release. The project has also passed Node 24.21.0 and Node 26.10.0 typecheck, build and offline suites. A genuine fresh macOS account installation has not been performed; the disposable prefix does not prove account provisioning, shell setup or permissions on a new account. Intel macOS is not covered. Provider and runtime installations, credentials, service registration, host containment, and remote cancellation are outside this install guide.
