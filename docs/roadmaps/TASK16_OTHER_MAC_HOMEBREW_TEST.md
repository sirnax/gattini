# Task 16 other-Mac Homebrew test bundle — prepared 28 September 2026

This is a portable **local** test of real `brew install`, formula `brew test`, fake-job execution, and `brew uninstall` on an Apple Silicon Mac. It is meant for the owner's iMac or other MacBook, provided that Mac reports `arm64`. The corrected script passed on the development Mac's normal Homebrew installation on 28 September 2026; the owner has supplied an iMac log showing the public formula, Node 24 and OpenSSL installed, while fake-job and uninstall results from that Mac remain pending. Task 16 and Checkpoint 7 remain open.

The public tap is now available. For a normal installation on the other Mac, use `brew install --formula sirnax/gattini/gattini` from the [public tap](https://github.com/sirnax/homebrew-gattini). The source archive that previously returned 404 is now a public [v0.2.0 release](https://github.com/sirnax/gattini/releases/tag/v0.2.0). The ZIP below remains an optional local-tap lifecycle test; it is not required for the direct install command.

## Exact bundle

- ZIP: `/private/tmp/gattini-homebrew-field-test-20260928.zip`
- ZIP SHA-256: `893f74ea629ee2dbd73c3b2f3c9a70a58b21e0dd38c62734eae2c0f219afa45c`
- Checked Gattini `0.2.0` archive inside: SHA-256 `97ab34442ff72130333945ff177ff82a82c78a469da050ff1f818d0cc027e06f`
- Source: `scripts/build-homebrew-field-kit.sh` and `scripts/run-homebrew-field-test.sh` in this repository. The builder rendered the current audited formula from the checked archive, committed it to a disposable local Git tap, included checksums and a first-read text guide, then made the ZIP. The local formula uses a `file:` URL to the ZIP's extracted archive; it is not a published tap or HTTPS release.

Exact build and unpack validation commands:

```sh
bash -n scripts/run-homebrew-field-test.sh
sh -n scripts/build-homebrew-field-kit.sh
sh scripts/build-homebrew-field-kit.sh /private/tmp/gattini-task16-isolated-brew-20260928/rebuilt-current
mkdir -p /private/tmp/gattini-field-zip-explicit-formula-check
ditto -xk /private/tmp/gattini-homebrew-field-test-20260928.zip /private/tmp/gattini-field-zip-explicit-formula-check
(cd /private/tmp/gattini-field-zip-explicit-formula-check/gattini-homebrew-field-test-20260928 && shasum -a 256 -c MANIFEST.sha256)
git -C /private/tmp/gattini-field-zip-explicit-formula-check/gattini-homebrew-field-test-20260928/tap-source status --short --branch
cmp -s scripts/run-homebrew-field-test.sh /private/tmp/gattini-field-zip-explicit-formula-check/gattini-homebrew-field-test-20260928/test-homebrew.sh
```

The builder reported archive checksum `OK` and formula `Syntax OK`. Extracting the ZIP preserved the local tap Git repository, and all six manifest entries returned `OK`; its Git worktree was clean. The final ZIP contains no run logs, report, job state, or credentials.

## Owner run on the other Mac

Copy the ZIP to an **Apple Silicon** Mac that has Homebrew. In Terminal, use the actual downloaded ZIP location in the first command. For example, if AirDrop put it in Downloads:

```sh
shasum -a 256 ~/Downloads/gattini-homebrew-field-test-20260928.zip
ditto -xk ~/Downloads/gattini-homebrew-field-test-20260928.zip /private/tmp
bash /private/tmp/gattini-homebrew-field-test-20260928/test-homebrew.sh
```

Compare the first command's hash with the ZIP SHA-256 above before running the script. The script checks macOS ARM architecture, expects normal Apple Silicon Homebrew at `/opt/homebrew`, refuses a pre-existing Gattini installation or same-named test tap, verifies its own file manifest, then uses a local `gattini/local-test` tap. It runs `brew install --formula gattini/local-test/gattini` **without** the disposable test's `--ignore-dependencies` workaround, followed by `brew test`. It starts the installed daemon only in the foreground test process, runs one offline fake job using private state in a path with spaces, checks exact status/result/events, stops the daemon, runs `brew uninstall --formula`, removes the local tap, and verifies that the job database is unchanged. It does not enable a login service or contact a model provider. On failure it attempts to remove the test installation and tap and keeps a console log.

Homebrew may download and install Node 24 plus its dependencies if that Mac does not already have them. Those shared dependencies may remain after Gattini is uninstalled; the script deliberately does not run `brew autoremove`. This is a real normal-prefix Gattini install **on the Mac where the owner runs the script**. The owner separately authorised the completed test on the development Mac; another-Mac testing is optional additional evidence and has not happened yet.

If the test prints `PASS`, return `/private/tmp/gattini-homebrew-field-test-20260928/report.json`. It records macOS, architecture, Homebrew and Node 24 versions, package checksum, the fake job ID and event sequences, and whether Gattini and the test tap were removed. If it fails, return the path printed for `console.log` or the log content after checking it for anything private. An Intel Mac stops at the architecture check before installation; the current formula does not claim Intel support.

## Local rehearsal and limit

The script was run against a separate disposable Homebrew 7.0.6 prefix, with an internal test-only environment override to use its copied Node 24 keg. The final ZIP extraction and `cmp -s` check confirmed its script bytes match the rehearsed source:

```sh
GATTINI_FIELD_DISPOSABLE_BREW=/private/tmp/gattini-task16-isolated-brew-20260928/brew-isolated bash /private/tmp/gattini-homebrew-field-test-20260928/test-homebrew.sh
```

It exited **0** after checksum validation, local tap addition, `brew install --formula`, `brew test`, fake-job status/result/events `[1,2,3]`, `brew uninstall --formula`, test-tap removal, and unchanged job database. The exact fake job was `6d88b05b-dded-4fe5-9bf6-054cc3dee57f`; the final database SHA-256 was `c4ca018dfe251102dd36ead64d305086062e11356016fa0a301ab436b75ba739`. The rehearsal's Node 24 was already present, so it **does not** establish dependency installation on a separate Mac. The normal-prefix development-Mac result is recorded in [Task 16 normal Homebrew validation](TASK16_NORMAL_HOMEBREW_TEST.md).
