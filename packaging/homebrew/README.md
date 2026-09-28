# Local Homebrew formula preparation

Gattini currently ships a command-line client and daemon, so its Homebrew package is a **formula**. Use `brew install --formula sirnax/gattini/gattini` and `brew uninstall --formula sirnax/gattini/gattini` on Apple Silicon macOS. `brew install --cask` selects casks, which are a separate package type and are not produced by this formula. A future standalone macOS `.app` could have its own cask after that app and its installation behavior are designed and tested. The VS Code extension has a separate distribution path.

The [public tap](https://github.com/sirnax/homebrew-gattini) installs the archive from the [source repository's v0.2.0 release](https://github.com/sirnax/gattini/releases/tag/v0.2.0). The formula is generated from a checked `release.json` and its exact archive; the renderer recomputes SHA-256 before writing a new lowercase `gattini.rb`.

```sh
node scripts/render-homebrew-formula.mjs \
  --release-json /absolute/release/release.json \
  --archive /absolute/release/gattini-0.2.0.tgz \
  --url file:///absolute/release/gattini-0.2.0.tgz \
  --homepage https://example.com/project-homepage \
  --out /absolute/disposable/gattini.rb
```

For a release URL, supply an HTTPS URL ending in the exact archive filename and the public source repository homepage. The local file URL must resolve to the checked archive. The version, platform, Node range and checksum come from `release.json`; the renderer rejects a mismatched archive. The formula supports macOS arm64 and declares `node@24` as its runtime dependency. It installs the two Gattini commands and offers a `brew services` definition; installing the formula alone does not register or launch the daemon. It contains no provider installation or login step and no user-state cleanup.

The generated formula includes a functional fake-job test using a disposable state directory and Unix socket. The exact `0.2.0` archive has been built reproducibly under Node 24 and 26; the public source tag `v0.2.0` rebuilds the downloaded archive byte for byte. A local named tap under a disposable Homebrew prefix passed `brew audit --strict`, `brew test`, a `0.1.0` → `0.2.0` upgrade, a clean `0.2.0` install, and uninstall with the job database preserved. After the owner expressly authorised this Mac's normal Homebrew, the same formula passed a real `brew install --formula`, `brew test`, offline fake job and `brew uninstall --formula` under `/opt/homebrew` using normal dependency resolution. The public tap subsequently passed a fresh unauthenticated archive download and disposable-prefix qualified install/test/uninstall. Gattini and the temporary test tap were removed after each test; durable test data remained. Node 24 was already installed on the development Mac; an owner-supplied iMac transcript subsequently showed Homebrew installing Node 24.21.0 as a fresh dependency, then removing it as unneeded after Gattini uninstall. A new macOS account remains untested. Homebrew service registration is opt-in; the owner manually started and stopped the service on the iMac.

The [Task 16 local validation record](../../docs/roadmaps/TASK16_LOCAL_VALIDATION.md) gives the exact archive checksum and Homebrew lifecycle evidence. The earlier `scripts/verify-local-release-stage.mjs` rehearsal checks package layout independently of Homebrew.

The [normal Homebrew test record](../../docs/roadmaps/TASK16_NORMAL_HOMEBREW_TEST.md) gives the actual development-Mac result, checks and side effects. For the owner's separate Apple Silicon Mac, the [other-Mac field-test record](../../docs/roadmaps/TASK16_OTHER_MAC_HOMEBREW_TEST.md) identifies a checked ZIP and the same one-command test. The owner-supplied iMac public-tap lifecycle result is recorded in the Task 16 publication record; the optional ZIP test was not run there.

Formula syntax and service behavior follow the official [Homebrew Formula Cookbook](https://docs.brew.sh/Formula-Cookbook) and [Node formula guidance](https://docs.brew.sh/Language-Specific-Formulae).

## Release procedure

The release owner uses the verified macOS arm64 archive and `release.json` from `scripts/package-local.mjs`. The generated formula must contain the exact release-asset HTTPS URL and SHA-256, and the tap repository must be named `homebrew-gattini` for the qualified install name `sirnax/gattini/gattini`. For each version:

1. Run the Node 24 and 26 offline gates, build the archive, verify its checksum, and compare the builds byte for byte.
2. Render `Formula/gattini.rb` with `scripts/render-homebrew-formula.mjs`, pointing to the versioned GitHub release asset. Run `ruby -c` and a named `brew audit --strict` in a temporary tap.
3. Tag the source commit that reproduces the archive, push the source and tap commits, and upload the archive, `.sha256`, and `release.json` as a draft release on `sirnax/gattini`. Download them back and verify the checksum and archive bytes.
4. Publish the source release and tap after reviewing their contents and visibility. Check the asset URL without authentication, then test a qualified `brew install --formula`, `brew test`, and `brew uninstall --formula` using a disposable location.
5. Record the public commit, tag, archive hash, install output, cleanup and any remaining fresh-machine limits in the roadmap. Never start `brew services` as part of the formula install test.

The [Homebrew tap guidance](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap) explains the `homebrew-` repository name and one-command qualified install. The tap and Gattini source are separate public repositories. The source release is the canonical archive location; the tap's initial `v0.2.0` release is a byte-identical mirror retained from staging.

Rebuild the published 0.2.0 archive from the source tag `v0.2.0`, not from the moving `main` branch. Main's installation documentation was updated after the release tag.
