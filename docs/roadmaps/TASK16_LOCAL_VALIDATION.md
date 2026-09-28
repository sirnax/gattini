# Task 16 local distribution validation — 28 September 2026

Task 16 remains open. This check prepares the current `0.2.0` macOS arm64 CLI/daemon archive and a local Homebrew formula. It does not create a tap, publish either package, install Gattini into the normal Homebrew prefix, register a startup service, package the VS Code client as a VSIX, or prove Intel/Linux/Windows support. The previous `0.1.0` Task 15 artifact was used only as a local upgrade fixture.

## Artifact and formula

Starting from clean `main` at `d0f183b`, these exact commands built the final checked archives after the local formula and guide edits:

```sh
env PATH=/opt/homebrew/opt/node@24/bin:$PATH node scripts/package-local.mjs --out-dir /private/tmp/gattini-task16-v020-final-node24-20260928
node scripts/package-local.mjs --out-dir /private/tmp/gattini-task16-v020-final-node26-20260928
cmp -s /private/tmp/gattini-task16-v020-final-node24-20260928/gattini-0.2.0.tgz /private/tmp/gattini-task16-v020-final-node26-20260928/gattini-0.2.0.tgz
```

Both builds succeeded and `cmp` exited 0. The archive is **84,578 bytes** with SHA-256 `438769ba23766df80612c58339a02b69092feb706f46e136a2c8107c62f53330`; `shasum -a 256 -c gattini-0.2.0.tgz.sha256` passed. The archive contains the CLI, daemon, licence, README and installation guide, with no extension or provider binary.

The renderer checked that archive and its release metadata, then produced `/private/tmp/gattini-task16-v020-final-formula-20260928/gattini.rb` using a local `file:` URL and placeholder homepage. Exact commands:

```sh
node scripts/render-homebrew-formula.mjs --release-json /private/tmp/gattini-task16-v020-final-node24-20260928/release.json --archive /private/tmp/gattini-task16-v020-final-node24-20260928/gattini-0.2.0.tgz --url file:///private/tmp/gattini-task16-v020-final-node24-20260928/gattini-0.2.0.tgz --homepage https://example.com/gattini --out /private/tmp/gattini-task16-v020-final-formula-20260928/gattini.rb
ruby -c /private/tmp/gattini-task16-v020-final-formula-20260928/gattini.rb
```

`ruby -c` reported `Syntax OK`. The generated formula declares macOS arm64 and `node@24`, installs CLI/daemon wrappers, provides an opt-in service definition, and now includes a functional fake-job test under Homebrew's temporary test directory. No service was enabled. The focused command `npm run typecheck && npm run build && node --test dist/tests/homebrew-formula.test.js` passed **1/1** after the formula changes.

## Disposable upgrade rehearsal

`scripts/verify-local-release-stage.mjs` checked both archive digests, extracted the old `0.1.0` and new `0.2.0` archives, staged Homebrew-style `libexec` wrappers in a path with spaces, ran a fake job with each version, restarted the daemon after switching versions, read the old job using the new CLI, paged new job events, and confirmed the SQLite database was unchanged after moving the staged installation aside. Its exact invocation was:

```sh
node scripts/verify-local-release-stage.mjs --old-archive /private/tmp/gattini-task15-final-node24/gattini-0.1.0.tgz --old-release /private/tmp/gattini-task15-final-node24/release.json --new-archive /private/tmp/gattini-task16-v020-final-node24-20260928/gattini-0.2.0.tgz --new-release /private/tmp/gattini-task16-v020-final-node24-20260928/release.json --node /opt/homebrew/opt/node@24/bin/node --work-dir '/private/tmp/gattini-task16-final-stage-upgrade-20260928 with spaces'
```

It passed with old job `256b6c1b-faf9-46df-b095-777ebec41223`, new job `edc0d836-af25-41af-ab1e-d5606446935c`, three new-job events and `statePreservedAfterUninstall:true`. This rehearses package layout and wrappers; **it is not a Homebrew formula install or `brew test`**.

## Homebrew audit attempt and limits

An initial sandboxed `brew audit --strict --formula /private/tmp/gattini-task16-v020-node24-20260928/Gattini.rb` failed before audit because Homebrew tried to write its cache under `/opt/homebrew/tmp`. A second attempt with disposable cache/log/temp variables and `HOMEBREW_NO_INSTALL_FROM_API=1` reached Homebrew's developer setup, which downloaded and installed its own Ruby audit gems under `/opt/homebrew/Library/Homebrew/vendor/bundle/ruby/4.0.0`. The exact second command was:

```sh
env HOMEBREW_CACHE=/private/tmp/gattini-task16-v020-node24-20260928/brew-cache HOMEBREW_TEMP=/private/tmp/gattini-task16-v020-node24-20260928/brew-temp HOMEBREW_LOGS=/private/tmp/gattini-task16-v020-node24-20260928/brew-logs HOMEBREW_NO_INSTALL_FROM_API=1 HOMEBREW_DEVELOPER=1 HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 brew audit --strict --formula /private/tmp/gattini-task16-v020-node24-20260928/Gattini.rb
```

Homebrew then rejected the formula path: this Homebrew 7.0.6 accepts named formulae in taps for `brew audit`, not standalone `.rb` paths. **No Gattini formula was installed**, but the Homebrew audit-gem side effect did modify the shared Homebrew installation; it has been disclosed to the owner and not removed. Do not repeat this audit against a file path. A named-formula audit and `brew test` require an isolated tap/prefix test setup or a separately approved Homebrew installation path.

Final offline gates after source changes passed on both runtimes:

| Runtime | Exact command | Result |
| --- | --- | --- |
| Node 24.21.0 | `env PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck && env PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build && env PATH=/opt/homebrew/opt/node@24/bin:$PATH node --test --test-concurrency=1 dist/tests/*.test.js > /private/tmp/gattini-task16-final-node24-tests.log 2>&1` | 202/202 passed |
| Node 26.10.0 | `npm run typecheck && npm run build && node --test --test-concurrency=1 dist/tests/*.test.js > /private/tmp/gattini-task16-final-node26-tests.log 2>&1` | 202/202 passed |

The local formula URL and homepage are placeholders. A real tap name, HTTPS release URL, publication workflow, and publish-or-defer decision still require the owner. A genuine fresh-account install and formula install/upgrade/uninstall remain unverified. The official [Homebrew Formula Cookbook](https://docs.brew.sh/Formula-Cookbook) describes named formula tests and audit; this local check does not claim those commands passed.

## Platform preparation and refreshed Mac artifact — 28 September 2026

The owner set the target order to macOS ARM, Debian/Ubuntu Linux, then Windows. Homebrew remains the Mac-specific Task 16 path. The builder now permits native Linux arm64/x64 archives with architecture-labelled filenames, and the daemon, CLI and editor share a Linux XDG state-location rule. `docs/installation-linux.md` describes a user-owned install. These changes do **not** yet establish a Linux build or Linux host behavior: cached Linux Docker images had no Node runtime, and no Node image was downloaded for this check. Windows remains unsupported.

The first sandboxed `npm test` attempt failed at disposable Unix socket creation with `listen EPERM`; it is not counted as a product test failure. The suite was rerun with local socket permission. Exact successful gates from the repository root:

```sh
env PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck
env PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test
env PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck --prefix extension && env PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build --prefix extension && env PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test --prefix extension
npm run typecheck && npm test
npm run typecheck --prefix extension && npm run build --prefix extension && npm test --prefix extension
```

Node 24.21.0 and Node 26.10.0 each passed **203/203 root tests** and **9/9 extension tests**. The new tests cover Linux state path selection and rejection of an unsupported Windows editor socket path. The root suite includes the disposable package lifecycle check on macOS; it does not execute a Linux binary.

The current Mac archive was rebuilt after these changes and checked against a second Node version:

```sh
env PATH=/opt/homebrew/opt/node@24/bin:$PATH node scripts/package-local.mjs --out-dir /private/tmp/gattini-task16-macarm-rebuild-20260928-node24
node scripts/package-local.mjs --out-dir /private/tmp/gattini-task16-macarm-rebuild-20260928-node26
cmp -s /private/tmp/gattini-task16-macarm-rebuild-20260928-node24/gattini-0.2.0.tgz /private/tmp/gattini-task16-macarm-rebuild-20260928-node26/gattini-0.2.0.tgz
(cd /private/tmp/gattini-task16-macarm-rebuild-20260928-node24 && shasum -a 256 -c gattini-0.2.0.tgz.sha256)
```

Both builds succeeded, `cmp` exited 0 and checksum verification reported `gattini-0.2.0.tgz: OK`. The refreshed archive is **85,751 bytes**, SHA-256 `1c249d546aa5eb7ed5a826cd7fc6ebcd941025ea6a23741d8350a76bdfb94aa8`. The earlier 84,578-byte archive and checksum above describe the prior source revision; they are not the current artifact.

```sh
mkdir -p /private/tmp/gattini-task16-macarm-rebuild-20260928-formula
node scripts/render-homebrew-formula.mjs --release-json /private/tmp/gattini-task16-macarm-rebuild-20260928-node24/release.json --archive /private/tmp/gattini-task16-macarm-rebuild-20260928-node24/gattini-0.2.0.tgz --url file:///private/tmp/gattini-task16-macarm-rebuild-20260928-node24/gattini-0.2.0.tgz --homepage https://example.com/gattini --out /private/tmp/gattini-task16-macarm-rebuild-20260928-formula/gattini.rb
ruby -c /private/tmp/gattini-task16-macarm-rebuild-20260928-formula/gattini.rb
node scripts/verify-local-release-stage.mjs --old-archive /private/tmp/gattini-task15-final-node24/gattini-0.1.0.tgz --old-release /private/tmp/gattini-task15-final-node24/release.json --new-archive /private/tmp/gattini-task16-macarm-rebuild-20260928-node24/gattini-0.2.0.tgz --new-release /private/tmp/gattini-task16-macarm-rebuild-20260928-node24/release.json --node /opt/homebrew/opt/node@24/bin/node --work-dir '/private/tmp/gattini-task16-macarm-rebuild-stage with spaces'
```

The formula rendered and `ruby -c` reported `Syntax OK`. The disposable staging upgrade passed with old job `f1f6fd11-87ea-4350-a848-1043ec23b66b`, new job `9c503863-e823-49d6-9631-520a5d90a23f`, three new-job events and `statePreservedAfterUninstall:true`. This still does not count as a named Homebrew audit, `brew test`, formula installation or tap publication.
