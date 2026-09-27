# Local Homebrew formula preparation

This directory is local Task 16 preparation. It is not a published tap or an installed formula. The formula is generated from a checked `release.json` and its exact archive; the renderer recomputes SHA-256 before writing a new lowercase `gattini.rb`.

```sh
node scripts/render-homebrew-formula.mjs \
  --release-json /absolute/release/release.json \
  --archive /absolute/release/gattini-0.2.0.tgz \
  --url file:///absolute/release/gattini-0.2.0.tgz \
  --homepage https://example.com/project-homepage \
  --out /absolute/disposable/gattini.rb
```

For a future release URL, supply an HTTPS URL ending in the exact archive filename and a real owner-approved HTTPS homepage. The local file URL must resolve to the checked archive. The version, platform, Node range and checksum come from `release.json`; the renderer rejects a mismatched archive. The formula supports macOS arm64 and declares `node@24` as its runtime dependency. It installs the two Gattini commands and offers a `brew services` definition; installing the formula alone does not register or launch the daemon. It contains no provider installation or login step and no user-state cleanup.

The generated formula includes a functional fake-job test using a disposable state directory and Unix socket. The exact `0.2.0` archive has been built reproducibly under Node 24 and 26. Homebrew's installed version does not accept a formula path for `brew audit`; it requires a named formula in a tap. Audit, `brew test`, and formula install/upgrade/uninstall remain pending an isolated Homebrew test environment. Do not run `brew install` into the normal `/opt/homebrew` prefix for this local validation. External tap creation, release publication, startup registration, and real-account installation require their separate owner decisions.

The [Task 16 local validation record](../../docs/roadmaps/TASK16_LOCAL_VALIDATION.md) gives the exact current artifact checksum and disposable `0.1.0` → `0.2.0` staging command. `scripts/verify-local-release-stage.mjs` checks archive contents, wrappers, fake-job execution, restart retrieval, event paging, and state preservation after staged uninstall. It does not execute Homebrew's installer.

Formula syntax and service behavior follow the official [Homebrew Formula Cookbook](https://docs.brew.sh/Formula-Cookbook) and [Node formula guidance](https://docs.brew.sh/Language-Specific-Formulae).
