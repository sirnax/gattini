# Install Gattini locally on macOS

This guide describes Gattini 0.2.0 for Apple Silicon (macOS arm64). The public Homebrew formula installs the versioned CLI and daemon archive with Node 24. The archive is also available for a manual npm installation. Gattini does not install or authenticate OpenCode, Codex, Claude Code, or any provider.

On the release builder's Apple Silicon Mac, from a Gattini source checkout with the locked development dependencies already installed, produce the tarball and checksum:

```sh
mkdir -p "$HOME/gattini-release"
node scripts/package-local.mjs --out-dir "$HOME/gattini-release"
```

For a manual npm installation, obtain `gattini-0.2.0.tgz` and its `.sha256` file from the [public v0.2.0 release](https://github.com/sirnax/gattini/releases/tag/v0.2.0) or a trusted transfer, place both in `~/gattini-release`, then verify them before installing:

```sh
cd "$HOME/gattini-release"
shasum -a 256 -c gattini-0.2.0.tgz.sha256
```

The checksum detects accidental corruption when checked against a checksum obtained through a trusted channel; it does not authenticate a release by itself. The archive declares macOS arm64 and Node `>=24` and has no production npm dependencies. The local builder checks its exact locked TypeScript and Node type versions before compiling.

## Current distribution paths

| Component | Local artifact | Status |
| --- | --- | --- |
| CLI and daemon | [Public 0.2.0 archive](https://github.com/sirnax/gattini/releases/tag/v0.2.0) with checksum and `release.json` | Built byte-identically under Node 24 and 26 on Apple Silicon; released from reproducible source tag `v0.2.0`. |
| Linux CLI and daemon | `gattini-0.2.0-linux-arm64.tgz` and `gattini-0.2.0-linux-x64.tgz` | Offline Node 24 suites passed in disposable Debian 12 containers on both architectures; packaged daemon/CLI restart checks passed on Ubuntu 24.04. Not published. |
| Homebrew formula | [Public `sirnax/gattini/gattini` formula](https://github.com/sirnax/homebrew-gattini) bound to the exact archive checksum | Strict audit, public-download, disposable public-tap install/test/uninstall, and a normal-prefix local install/test/uninstall passed. An owner-supplied iMac log confirms a separate install with a fresh Node 24 dependency; its offline job and uninstall checks are pending. |
| VS Code client | `extension/` source and compiled development host | Local extension-host and manual checks passed. No VSIX or Marketplace release has been prepared or installed into a normal profile. |

The verified package targets macOS arm64. Linux ARM64/x64 archives have passed disposable Debian 12 and Ubuntu 24.04 checks; see the [Linux guide](installation-linux.md) and the source repository’s Task 16 Linux validation record. Intel macOS and Windows builds have not been validated. The editor client requires the matching `0.2.0` daemon and protocol v2; it does not contain or start the daemon.

## Install with Homebrew

On an Apple Silicon Mac with Homebrew, run:

```sh
brew install --formula sirnax/gattini/gattini
```

Homebrew adds the tap and installs `node@24` if needed. The formula checks the archive SHA-256 before installation. Installing the formula alone does not start `gattinid` or register a login service. Use the manual daemon steps below. If an earlier attempt failed while the release archive was private, rerun the same command; the published archive now downloads without authentication.

## Manual npm install

The manual npm examples use a user-owned prefix at `~/.local`, so installation does not require administrator access. This route needs Node.js 24 or newer and its bundled npm, installed from a source you trust. Add the prefix's `bin` directory to your `PATH` if it is not already there. For zsh:

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

Login startup registration is not part of these installation steps. The Homebrew formula defines an optional service, but `brew install` does not enable it. Start and stop the daemon manually unless you separately choose to enable that service.

## Upgrade while preserving state

Before upgrading, finish or cancel active work where possible, then press Control-C in the daemon terminal and wait for it to exit. Keep a backup as described below. For a Homebrew installation, use `brew upgrade sirnax/gattini/gattini` when a newer formula is published. For a manual npm installation, install the new tarball over the existing user prefix:

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

Stop the daemon first. For Homebrew, remove the formula and optionally the tap:

```sh
brew uninstall --formula sirnax/gattini/gattini
brew untap sirnax/gattini
```

For a manual npm installation, remove the package from the same user prefix:

```sh
npm uninstall --global --prefix "$HOME/.local" gattini
```

This removes the installed CLI and daemon binaries. It does not remove `~/Library/Application Support/Gattini`, jobs, role configuration, retained evidence, backups, or separately located owned worktrees. Keep that data for a later reinstall, or remove it yourself only after reviewing what it contains. If you added the `PATH` line above, you may remove it from `~/.zshrc`.

## Verification status and limits

The package build, checksum, disposable user-prefix install/upgrade/uninstall, packaged fake job, version mismatch, and stopped-state migration backup/restore have offline tests on the Apple Silicon development Mac. A real normal-prefix Homebrew install/test/uninstall passed there. The public tap and archive then passed a disposable-prefix install/test/uninstall; that test used an existing Node 24 dependency rather than provisioning it. The earlier upgrade fixture starts from a locally fabricated `0.0.9` package because Gattini had no previous public release. Node 24.21.0 and Node 26.10.0 passed typecheck, build and offline suites. An owner-supplied log confirms a separate iMac installed the public formula, with Homebrew downloading Node 24.21.0 and upgrading OpenSSL. That Mac's offline job and uninstall checks, and a new macOS account, have not been observed. Intel macOS is not covered. Provider and runtime installations, credentials, service registration, host containment, and remote cancellation are outside this install guide.
