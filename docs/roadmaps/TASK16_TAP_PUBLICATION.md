# Task 16 GitHub tap publication — 28 September 2026

The owner asked to commit, clean up, push and make a direct Homebrew formula install available on another Mac. The [Gattini source](https://github.com/sirnax/gattini) and [Homebrew tap](https://github.com/sirnax/homebrew-gattini) are now **public**. The source `v0.2.0` release contains the checked archive, checksum and metadata. The tap's current `main` commit is `412f2af`, with a reviewed MIT license, README and generated `Formula/gattini.rb`. An unauthenticated Mac can fetch the archive. The qualified install command is `brew install --formula sirnax/gattini/gattini`.

The formula points to `https://github.com/sirnax/gattini/releases/download/v0.2.0/gattini-0.2.0.tgz` and pins SHA-256 `97ab34442ff72130333945ff177ff82a82c78a469da050ff1f818d0cc027e06f`. The checked archive includes the CLI, daemon, MIT license, README and installation guides. A scan of the extracted archive found no user home path, personal email, or matching GitHub/OpenAI token literal. The source's annotated `v0.2.0` tag points to `fd0335d`; rebuilding from that tag with Node 24 produced the public archive byte for byte. The tap's initial `v0.2.0` release is a byte-identical mirror from staging; the source release is the canonical archive location.

## Commands and results before publication

```sh
env PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run typecheck
env PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test > /private/tmp/gattini-publish-node24-tests.log 2>&1
npm run typecheck
npm test > /private/tmp/gattini-publish-node26-tests.log 2>&1
env PATH=/opt/homebrew/opt/node@24/bin:$PATH node scripts/package-local.mjs --out-dir /private/tmp/gattini-public-release-node24-20260928
cmp -s /private/tmp/gattini-public-release-node24-20260928/gattini-0.2.0.tgz /private/tmp/gattini-task16-isolated-brew-20260928/rebuilt-current/gattini-0.2.0.tgz
(cd /private/tmp/gattini-public-release-node24-20260928 && shasum -a 256 -c gattini-0.2.0.tgz.sha256)
node scripts/render-homebrew-formula.mjs --release-json /private/tmp/gattini-task16-isolated-brew-20260928/rebuilt-current/release.json --archive /private/tmp/gattini-task16-isolated-brew-20260928/rebuilt-current/gattini-0.2.0.tgz --url https://github.com/sirnax/homebrew-gattini/releases/download/v0.2.0/gattini-0.2.0.tgz --homepage https://github.com/sirnax/homebrew-gattini --out /private/tmp/gattini-public-tap-20260928/Formula/gattini.rb
ruby -c /private/tmp/gattini-public-tap-20260928/Formula/gattini.rb
/private/tmp/gattini-task16-isolated-brew-20260928/brew-isolated tap sirnax/gattini /private/tmp/gattini-public-tap-20260928
/private/tmp/gattini-task16-isolated-brew-20260928/brew-isolated audit --strict sirnax/gattini/gattini
/private/tmp/gattini-task16-isolated-brew-20260928/brew-isolated untap sirnax/gattini
```

Node 24.21.0 and 26.10.0 each passed typecheck and **203/203** offline root tests. The new Node 24 archive matched the previously installed and tested archive byte for byte. Its checksum check returned `OK`; Ruby syntax returned `Syntax OK`; named strict Homebrew audit returned success without findings. The remote tap commit and tag were pushed. The GitHub release was initially staged as a draft with three assets: the 85,960-byte archive, its `.sha256`, and `release.json`. `gh release download v0.2.0 --repo sirnax/homebrew-gattini` retrieved the assets; its checksum check returned `OK`, and the archive matched the local bytes byte for byte.

Automatic approval review initially rejected publishing the draft and making the tap public, saying the owner's earlier request did not clearly authorize the exact public disclosure. The tap remained private and release draft at that point. After the owner reported the resulting 404 and explicitly requested setup for the now-public source repo, the draft was published and the reviewed tap made public. No alternative route was used to bypass the earlier rejection.

## Public release and qualified Homebrew test

The source repository was public by the owner's next message. Its annotated `v0.2.0` tag was pushed at `fd0335d` and a release with the 85,960-byte archive, `.sha256` and `release.json` was published. The tap's staged release was published and its visibility changed to public. The tap formula was regenerated to use the public source release URL, passed `ruby -c` and named `brew audit --strict`, then was committed and pushed as `412f2af`. The public source and tap URLs were both checked without authentication. The source archive download had SHA-256 `97ab34442ff72130333945ff177ff82a82c78a469da050ff1f818d0cc027e06f`, byte-identical to the tested local archive.

The principal publication and verification commands, run with the existing GitHub HTTPS credential for `gh`, were:

```sh
git tag -a v0.2.0 fd0335d -m 'Gattini 0.2.0 macOS arm64 source release'
git push origin v0.2.0
gh release create v0.2.0 /private/tmp/gattini-public-release-node24-20260928/gattini-0.2.0.tgz /private/tmp/gattini-public-release-node24-20260928/gattini-0.2.0.tgz.sha256 /private/tmp/gattini-public-release-node24-20260928/release.json --repo sirnax/gattini --verify-tag --title 'Gattini 0.2.0 for Apple Silicon macOS' --notes 'First Homebrew formula release for Apple Silicon macOS. The attached CLI/daemon archive is SHA-256 verified. Install with brew install --formula sirnax/gattini/gattini. Gattini runs an offline fake adapter by default; it does not automatically start a service or call a provider.'
gh release edit v0.2.0 --repo sirnax/homebrew-gattini --draft=false
gh repo edit sirnax/homebrew-gattini --visibility public --accept-visibility-change-consequences
curl --fail --location --silent --show-error --output /private/tmp/gattini-public-unauthenticated-20260928/gattini-source-0.2.0.tgz https://github.com/sirnax/gattini/releases/download/v0.2.0/gattini-0.2.0.tgz
shasum -a 256 /private/tmp/gattini-public-unauthenticated-20260928/gattini-source-0.2.0.tgz
cmp -s /private/tmp/gattini-public-unauthenticated-20260928/gattini-source-0.2.0.tgz /private/tmp/gattini-public-release-node24-20260928/gattini-0.2.0.tgz
```

The exact disposable public install command was:

```sh
bash /private/tmp/gattini-public-brew-smoke-20260928.sh
```

That script used the isolated Homebrew 7.0.6 prefix under `/private/tmp`, automatically tapped the public `sirnax/gattini` repository, ran `brew install --formula --ignore-dependencies sirnax/gattini/gattini`, confirmed the formula's source URL, passed `HOMEBREW_DEVELOPER=1 brew test sirnax/gattini/gattini`, and then ran `brew uninstall --formula --force` and `brew untap`. It exited **0** and printed `PASS`. The unsupported `--ignore-dependencies` option was confined to this nonstandard isolated prefix, which had copied Node 24; the previous normal `/opt/homebrew` install test used ordinary dependency resolution. A completed other-Mac install with a fresh Node dependency is still unconfirmed. No startup service, extension publication, or paid provider test was run; the direct-edit gate remains disabled.
