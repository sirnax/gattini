# Task 16 GitHub tap staging — 28 September 2026

The owner asked to commit, clean up, push and make a direct Homebrew formula install available on another Mac. The source repository was pushed privately to `sirnax/gattini`. A separate `sirnax/homebrew-gattini` tap was created **private** for staging. The tap contains a reviewed MIT license, README and generated `Formula/gattini.rb` at commit `ae0c4ff`, plus an annotated `v0.2.0` tag. Its Gattini 0.2.0 release is currently a **draft** in the private tap. Neither the tap nor archive is yet reachable by an unauthenticated Mac.

The formula points to the intended public archive URL `https://github.com/sirnax/homebrew-gattini/releases/download/v0.2.0/gattini-0.2.0.tgz` and pins SHA-256 `97ab34442ff72130333945ff177ff82a82c78a469da050ff1f818d0cc027e06f`. The checked archive includes the CLI, daemon, MIT license, README and installation guides. A scan of the extracted archive found no user home path, personal email, or matching GitHub/OpenAI token literal. The tap README gives the intended command `brew install --formula sirnax/gattini/gattini` for Apple Silicon macOS.

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

Node 24.21.0 and 26.10.0 each passed typecheck and **203/203** offline root tests. The new Node 24 archive matched the previously installed and tested archive byte for byte. Its checksum check returned `OK`; Ruby syntax returned `Syntax OK`; named strict Homebrew audit returned success without findings. The remote tap commit and tag were pushed. The GitHub draft release holds three assets: the 85,960-byte archive, its `.sha256`, and `release.json`. `gh release download v0.2.0 --repo sirnax/homebrew-gattini` retrieved the assets; its checksum check returned `OK`, and the archive matched the local bytes byte for byte.

Automatic approval review rejected publishing the draft and making the tap public, saying the user's request to push and enable another-Mac installation did not clearly authorize the exact public disclosure. We requested explicit clarification and left the tap private and release draft. No alternative route was used to bypass that rejection. After explicit approval, the remaining checks are to publish the draft, make the reviewed tap public, verify the archive without authentication, and test the qualified install path. Until then, Task 16 and Checkpoint 7 remain open. No startup service, extension publication, or paid provider test was run; the direct-edit gate remains disabled.
