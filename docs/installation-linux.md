# Install Gattini locally on Debian or Ubuntu Linux

This guide is for the local `0.2.0` Linux archive. Choose the file matching `uname -m`: `aarch64` uses `gattini-0.2.0-linux-arm64.tgz`, and `x86_64` uses `gattini-0.2.0-linux-x64.tgz`. Linux release validation is recorded separately in the roadmap; an archive alone does not prove a distribution or CPU works. No package is published, and no provider runtime or login is bundled.

Use Node.js 24 or newer and its npm. Obtain Node from a source you trust; Gattini does not install it. On a source checkout with the pinned development dependencies already present, `node scripts/package-local.mjs --out-dir ABSOLUTE_DIRECTORY` builds the archive for the **native** Linux architecture. It refuses other platforms. The output includes `release.json` and a `.sha256` file. A checksum detects corruption only when obtained through a trusted channel.

For a user-owned install, put the matching archive and checksum in `~/gattini-release`, verify them, then install without root:

```sh
cd "$HOME/gattini-release"
sha256sum -c gattini-0.2.0-linux-ARCH.tgz.sha256
mkdir -p "$HOME/.local"
npm install --global --prefix "$HOME/.local" "$HOME/gattini-release/gattini-0.2.0-linux-ARCH.tgz"
```

Replace `ARCH` with `arm64` or `x64`. Add `$HOME/.local/bin` to your shell `PATH` if needed. The CLI and daemon must come from the same release; they check the protocol and release version before a job request.

Start `gattinid` manually in one terminal. In another, `gattini start --task-file TASK_FILE --idempotency-key KEY --json` submits a durable fake job by default; `gattini status JOB_ID --json`, `gattini events JOB_ID --json`, and `gattini result JOB_ID --json` inspect it. Press Control-C in the daemon terminal to stop it cleanly. Gattini does not register a systemd service or enable startup automatically.

By default, Linux state is under `$XDG_STATE_HOME/gattini` when `XDG_STATE_HOME` is set, otherwise `~/.local/state/gattini`. A set `XDG_STATE_HOME` must be absolute. Set the same absolute `GATTINI_STATE_DIR` for the daemon, CLI, and editor to override it. The daemon creates the final directory with owner-only permissions and refuses a shared or symlinked state directory. Do not run two daemons against one state directory. Jobs, role configuration, and retained evidence live there; stop the daemon before copying or restoring the full state directory.

Before upgrading, stop the daemon and keep a private copy of the full state directory. Install the new archive into the same user prefix, start the new daemon, and confirm historical jobs are readable. An older daemon must not open a database migrated by a newer release; rollback requires restoring the pre-upgrade state copy. `npm uninstall --global --prefix "$HOME/.local" gattini` removes the commands but preserves the state directory. Review it before deleting anything.

Guarded code jobs also require Git and an explicitly configured runtime installed separately. A Git worktree is not host containment. Provider calls, model availability, desktop integration, and cancellation of remote computation are outside this installation check. The legacy direct-edit gate remains disabled.
