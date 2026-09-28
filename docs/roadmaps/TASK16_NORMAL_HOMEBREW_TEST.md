# Task 16 normal Homebrew test — 28 September 2026

The owner expressly authorised one Gattini formula install, offline test and uninstall in this development Mac's normal Homebrew. The final run passed on macOS 26.6.2 arm64 with Homebrew 7.0.6 under `/opt/homebrew`. This is a real formula lifecycle test, not a disposable-prefix simulation. No tap or package was published.

## Exact run and result

The checked Gattini 0.2.0 archive SHA-256 was `97ab34442ff72130333945ff177ff82a82c78a469da050ff1f818d0cc027e06f`. The command was:

```sh
bash /private/tmp/gattini-homebrew-field-test-20260928/test-homebrew.sh
```

The corrected script exited **0**. Its log is `/private/tmp/gattini-homebrew-field-test-20260928-normal-mac-result/run.9d6Ief/console.log` and machine report is `/private/tmp/gattini-homebrew-field-test-20260928-normal-mac-result/report.json`. It verified six bundle manifest entries, tapped the temporary local `gattini/local-test` Git repository, installed `gattini/local-test/gattini` using `brew install --formula` with normal dependency resolution, and listed `gattini 0.2.0`. `HOMEBREW_DEVELOPER=1 brew test gattini/local-test/gattini` passed. The installed daemon ran one offline fake job in `state with spaces`; its job ID was `73f73276-d6d3-4bb2-ad57-c3a4bec61394`. CLI status was `completed`, the result matched the exact job ID, and paged events had sequences `[1,2,3]`. The script stopped the daemon, ran `brew uninstall --formula --force`, and untapped `gattini/local-test`.

Independent post-run checks found no Gattini formula in `brew list --formula`, no test tap in `brew tap`, no `/opt/homebrew/bin/gattini` or `/opt/homebrew/bin/gattinid`, no `/opt/homebrew/Cellar/gattini`, and no test socket. The durable `jobs.sqlite` remained with the same before/after SHA-256 `fbacbfa894aa194f75c18170ac64c4ea8185cf2549b0a474ac4e5f0c998521b3`. The script did not register a startup service or call a model provider. The direct-edit gate remained disabled.

## Script correction and final portable bundle

The first normal-prefix attempt reached the temporary tap but stopped before installation: Bash treated expansion of an empty `install_flags` array as an unbound variable. The exit trap reported code 0 even though no report existed. The tap was removed. We changed the script to use explicit normal/disposable install branches and to return nonzero unless it reaches the completed report. The second run above passed. The first attempt log remains at `/private/tmp/gattini-homebrew-field-test-first-attempt-20260928/console.log`.

A failed preflight was also checked with `GATTINI_FIELD_DISPOSABLE_BREW=/bin/false bash /private/tmp/gattini-homebrew-field-test-20260928/test-homebrew.sh`; it exited **1**, printed `FAILED`, and made no Homebrew change. Its run log was moved out of the portable kit.

After the successful run, its job data and report were moved out of the portable kit. The kit was rebuilt from the corrected repository script with:

```sh
bash -n scripts/run-homebrew-field-test.sh
sh scripts/build-homebrew-field-kit.sh /private/tmp/gattini-task16-isolated-brew-20260928/rebuilt-current
ditto -xk /private/tmp/gattini-homebrew-field-test-20260928.zip /private/tmp/gattini-homebrew-final-zip-check
(cd /private/tmp/gattini-homebrew-final-zip-check/gattini-homebrew-field-test-20260928 && shasum -a 256 -c MANIFEST.sha256)
cmp -s scripts/run-homebrew-field-test.sh /private/tmp/gattini-homebrew-field-test-20260928/test-homebrew.sh
git -C /private/tmp/gattini-homebrew-field-test-20260928/tap-source status --short
```

All six manifest entries returned `OK`, script comparison succeeded, and the local tap was clean. The final portable ZIP is `/private/tmp/gattini-homebrew-field-test-20260928.zip`, SHA-256 `893f74ea629ee2dbd73c3b2f3c9a70a58b21e0dd38c62734eae2c0f219afa45c`. It contains no run state or logs. The [other-Mac field instructions](TASK16_OTHER_MAC_HOMEBREW_TEST.md) point to this corrected bundle.

## Limits and side effects

Node 24.21.0 was already installed, so this run did not test installing Node on a Mac that lacks it. Homebrew auto-updated three taps, upgraded `openssl@3` to 3.6.4_1, and updated its audit gems during the authorised normal-prefix operation. Those shared changes were left in place. The local formula still has a placeholder homepage and `file:` archive URL. An actual published HTTPS release, owner-approved tap name, fresh Mac/account check if required, and publication or explicit deferral decision remain open. Task 16 and Checkpoint 7 are not complete.
