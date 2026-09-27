# Local Homebrew formula preparation

This directory is a draft for Task 16. It is not a published tap or an installed formula. The formula is generated from a Task 15 `release.json` and its exact archive; the renderer recomputes SHA-256 before writing a new `Gattini.rb`.

```sh
node scripts/render-homebrew-formula.mjs \
  --release-json /absolute/release/release.json \
  --archive /absolute/release/gattini-0.1.0.tgz \
  --url file:///absolute/release/gattini-0.1.0.tgz \
  --homepage https://example.com/project-homepage \
  --out /absolute/disposable/Gattini.rb
```

For a future release URL, supply an HTTPS URL ending in the exact archive filename and a real owner-approved HTTPS homepage. The local file URL must resolve to the checked archive. The version, platform, Node range and checksum come from `release.json`; the renderer rejects a mismatched archive. The formula supports macOS arm64 and declares `node@24` as its runtime dependency. It installs the two Gattini commands and offers a `brew services` definition; installing the formula alone does not register or launch the daemon. It contains no provider installation or login step and no user-state cleanup.

The generated formula still needs `brew audit --strict --formula`, `brew test`, and disposable-prefix install/upgrade/uninstall verification on the supported Mac. Check package layout and command wrappers in that install before publication. External tap creation, release publication, startup registration, and real-account installation require their separate owner decisions.

Formula syntax and service behavior follow the official [Homebrew Formula Cookbook](https://docs.brew.sh/Formula-Cookbook) and [Node formula guidance](https://docs.brew.sh/Language-Specific-Formulae).
