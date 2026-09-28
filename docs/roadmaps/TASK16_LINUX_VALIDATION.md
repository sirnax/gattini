# Task 16 Linux local package validation — 28 September 2026

The owner set the platform order to macOS ARM, Debian/Ubuntu Linux, then Windows, and authorised downloading official Node 24 Docker images for disposable Linux tests. This record covers local `0.2.0` Linux **arm64** and **x64** archives. It does not close the macOS Homebrew tap task or authorise publication, a normal-account installation, a startup service, or a paid provider call.

## Test environment and exact setup

The host was macOS arm64. Linux arm64 ran through Docker's Linux VM; Linux x64 ran under Docker architecture emulation, **not a native x64 host**. Official `node:24-bookworm-slim` supplied Node **24.21.0** and npm **11.19.0**. Its pulled manifest digest was `sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6`. The image lacked Git, so these commands built disposable Debian 12 test images containing Git 2.39.5:

```sh
docker pull --platform linux/arm64 node:24-bookworm-slim
docker pull --platform linux/amd64 node:24-bookworm-slim
mkdir -p /private/tmp/gattini-linux-node24-image
cat > /private/tmp/gattini-linux-node24-image/Dockerfile <<'DOCKERFILE'
FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
DOCKERFILE
docker build --platform linux/arm64 -t gattini-test-node24:bookworm-arm64 /private/tmp/gattini-linux-node24-image
docker build --platform linux/amd64 -t gattini-test-node24:bookworm-x64 /private/tmp/gattini-linux-node24-image
```

The image downloads and Git installation used network access. **All Gattini suites, builds and smoke runs below used `--network none`**, `--pull=never`, a read-only source mount and disposable working directories. No provider was invoked. The Mac `node_modules` contains only the pinned TypeScript and Node type development packages; the container copied the checkout into `/tmp/work` before building.

## Full Debian gates

These were the exact full-suite commands after the portability fixture fixes:

```sh
docker run --rm --pull=never --platform linux/arm64 --network none --user 501:20 -e HOME=/tmp -e npm_config_cache=/tmp/npm-cache --mount type=bind,src=/Users/nathanlord/VS/gattini/gattini,dst=/source,readonly --mount type=bind,src=/private/tmp/gattini-linux-arm64-validation-20260928,dst=/out -w /tmp gattini-test-node24:bookworm-arm64 sh -ec 'mkdir -p /tmp/work; cp -R /source/. /tmp/work; cd /tmp/work; node -p "process.version + \" \" + process.platform + \" \" + process.arch"; git --version; npm run typecheck; if npm test > /out/root-tests.log 2>&1; then tail -n 9 /out/root-tests.log; else tail -n 80 /out/root-tests.log; exit 1; fi; npm run typecheck --prefix extension; npm run build --prefix extension; if npm test --prefix extension > /out/extension-tests.log 2>&1; then tail -n 9 /out/extension-tests.log; else tail -n 80 /out/extension-tests.log; exit 1; fi; node scripts/package-local.mjs --out-dir /out/release; cd /out/release; sha256sum -c gattini-0.2.0-linux-arm64.tgz.sha256'
docker run --rm --pull=never --platform linux/amd64 --network none --user 501:20 -e HOME=/tmp -e npm_config_cache=/tmp/npm-cache --mount type=bind,src=/Users/nathanlord/VS/gattini/gattini,dst=/source,readonly --mount type=bind,src=/private/tmp/gattini-linux-x64-validation-20260928,dst=/out -w /tmp gattini-test-node24:bookworm-x64 sh -ec 'mkdir -p /tmp/work; cp -R /source/. /tmp/work; cd /tmp/work; node -p "process.version + \" \" + process.platform + \" \" + process.arch"; git --version; npm run typecheck; if npm test > /out/root-tests.log 2>&1; then tail -n 9 /out/root-tests.log; else tail -n 80 /out/root-tests.log; exit 1; fi; npm run typecheck --prefix extension; npm run build --prefix extension; if npm test --prefix extension > /out/extension-tests.log 2>&1; then tail -n 9 /out/extension-tests.log; else tail -n 80 /out/extension-tests.log; exit 1; fi; node scripts/package-local.mjs --out-dir /out/release; cd /out/release; sha256sum -c gattini-0.2.0-linux-x64.tgz.sha256'
```

Both platforms reported `v24.21.0 linux` with the expected `arm64` or `x64` CPU. Both passed **203/203 root tests** and **9/9 extension tests**. The root package lifecycle test made two byte-identical native packages, installed/upgraded/uninstalled within a disposable npm prefix and retained state. The extension tests exercised protocol v2, cursor replay, disconnect/reconnect, release mismatch and Workspace Trust. These are mocked and daemon-integrated extension tests, **not a Linux graphical VS Code extension-host run**.

An initial arm64 run passed 196/203: seven older fixtures hard-coded macOS `/private/tmp`. They now use `os.tmpdir()`, and the full arm64 gate passed again after all fixture changes. An initial x64 run passed 202/203: under emulation, a 400 ms process-cleanup test timed out before its child printed readiness. The fixture now waits longer while still asserting process-group termination and no late write; its focused 5/5 test and the full 203/203 x64 gate passed. These failures and fixes were in tests, not accepted as Linux product passes. After the x64 timing adjustment, the final arm64 root rerun used this exact command and passed **203/203**:

```sh
docker run --rm --pull=never --platform linux/arm64 --network none --user 501:20 -e HOME=/tmp -e npm_config_cache=/tmp/npm-cache --mount type=bind,src=/Users/nathanlord/VS/gattini/gattini,dst=/source,readonly --mount type=bind,src=/private/tmp/gattini-linux-arm64-validation-20260928,dst=/out -w /tmp gattini-test-node24:bookworm-arm64 sh -ec 'mkdir -p /tmp/work; cp -R /source/. /tmp/work; cd /tmp/work; npm run typecheck; if npm test > /out/root-tests-final.log 2>&1; then tail -n 9 /out/root-tests-final.log; else tail -n 80 /out/root-tests-final.log; exit 1; fi'
```

## Final archives and packaged restart checks

After the installation guides were updated, the exact final packages were built and the focused install lifecycle was rerun. The commands for each architecture were:

```sh
docker run --rm --pull=never --platform linux/arm64 --network none --user 501:20 -e HOME=/tmp -e npm_config_cache=/tmp/npm-cache --mount type=bind,src=/Users/nathanlord/VS/gattini/gattini,dst=/source,readonly --mount type=bind,src=/private/tmp/gattini-linux-arm64-final-20260928,dst=/out -w /tmp gattini-test-node24:bookworm-arm64 sh -ec 'mkdir -p /tmp/work; cp -R /source/. /tmp/work; cd /tmp/work; npm run build; if node --test dist/tests/package-lifecycle.test.js > /out/package-lifecycle.log 2>&1; then tail -n 9 /out/package-lifecycle.log; else tail -n 80 /out/package-lifecycle.log; exit 1; fi; node scripts/package-local.mjs --out-dir /out/release; cd /out/release; sha256sum -c gattini-0.2.0-linux-arm64.tgz.sha256'
docker run --rm --pull=never --platform linux/amd64 --network none --user 501:20 -e HOME=/tmp -e npm_config_cache=/tmp/npm-cache --mount type=bind,src=/Users/nathanlord/VS/gattini/gattini,dst=/source,readonly --mount type=bind,src=/private/tmp/gattini-linux-x64-final-20260928,dst=/out -w /tmp gattini-test-node24:bookworm-x64 sh -ec 'mkdir -p /tmp/work; cp -R /source/. /tmp/work; cd /tmp/work; npm run build; if node --test dist/tests/package-lifecycle.test.js > /out/package-lifecycle.log 2>&1; then tail -n 9 /out/package-lifecycle.log; else tail -n 80 /out/package-lifecycle.log; exit 1; fi; node scripts/package-local.mjs --out-dir /out/release; cd /out/release; sha256sum -c gattini-0.2.0-linux-x64.tgz.sha256'
```

Both focused package lifecycle gates passed **3/3**. `sha256sum -c` reported `OK`. The final `release.json` and archive manifest identify the native Linux CPU, Node `>=24`, CLI and daemon bins, and zero production dependencies:

| CPU | Archive | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| arm64 | `/private/tmp/gattini-linux-arm64-final-20260928/release/gattini-0.2.0-linux-arm64.tgz` | 86,199 | `36a53a92346ecac8ca40a7f2e5c488f3e883c29181b53372898987bd37458bbb` |
| x64 | `/private/tmp/gattini-linux-x64-final-20260928/release/gattini-0.2.0-linux-x64.tgz` | 86,201 | `49f4f1fe22b8439c2d4882316033bf938a0d2b1667e1fcd4a9c63096eb20b2ef` |

`sh scripts/verify-linux-xdg-smoke.sh ARCHIVE WORK_DIR SUMMARY_JSON` extracted each archive, used **no `GATTINI_STATE_DIR` override**, placed state under `XDG_STATE_HOME` containing spaces, submitted a fake job, stopped and restarted the daemon, then recovered the exact job status, result, and event sequences `[1,2,3]`. The four final runs used these exact container commands:

```sh
docker run --rm --pull=never --platform linux/arm64 --network none --user 501:20 -e HOME=/tmp --mount type=bind,src=/Users/nathanlord/VS/gattini/gattini,dst=/source,readonly --mount type=bind,src=/private/tmp/gattini-linux-arm64-final-20260928/release,dst=/release,readonly --mount type=bind,src=/private/tmp/gattini-linux-arm64-final-20260928,dst=/out -w /source gattini-test-node24:bookworm-arm64 sh scripts/verify-linux-xdg-smoke.sh /release/gattini-0.2.0-linux-arm64.tgz '/tmp/gattini final debian arm64' /out/xdg-smoke.json
docker run --rm --pull=never --platform linux/amd64 --network none --user 501:20 -e HOME=/tmp --mount type=bind,src=/Users/nathanlord/VS/gattini/gattini,dst=/source,readonly --mount type=bind,src=/private/tmp/gattini-linux-x64-final-20260928/release,dst=/release,readonly --mount type=bind,src=/private/tmp/gattini-linux-x64-final-20260928,dst=/out -w /source gattini-test-node24:bookworm-x64 sh scripts/verify-linux-xdg-smoke.sh /release/gattini-0.2.0-linux-x64.tgz '/tmp/gattini final debian x64' /out/xdg-smoke.json
docker run --rm --pull=never --platform linux/arm64 --network none --user 501:20 -e HOME=/tmp -e PATH=/tool:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin --mount type=bind,src=/Users/nathanlord/VS/gattini/gattini,dst=/source,readonly --mount type=bind,src=/private/tmp/gattini-linux-arm64-final-20260928/release,dst=/release,readonly --mount type=bind,src=/private/tmp/gattini-linux-arm64-validation-20260928/ubuntu-node,dst=/tool,readonly --mount type=bind,src=/private/tmp/gattini-linux-arm64-final-20260928,dst=/out -w /source ubuntu:24.04 sh scripts/verify-linux-xdg-smoke.sh /release/gattini-0.2.0-linux-arm64.tgz '/tmp/gattini final ubuntu arm64' /out/ubuntu-xdg-smoke.json
docker run --rm --pull=never --platform linux/amd64 --network none --user 501:20 -e HOME=/tmp -e PATH=/tool:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin --mount type=bind,src=/Users/nathanlord/VS/gattini/gattini,dst=/source,readonly --mount type=bind,src=/private/tmp/gattini-linux-x64-final-20260928/release,dst=/release,readonly --mount type=bind,src=/private/tmp/gattini-linux-x64-validation-20260928/ubuntu-node,dst=/tool,readonly --mount type=bind,src=/private/tmp/gattini-linux-x64-final-20260928,dst=/out -w /source ubuntu:24.04 sh scripts/verify-linux-xdg-smoke.sh /release/gattini-0.2.0-linux-x64.tgz '/tmp/gattini final ubuntu x64' /out/ubuntu-xdg-smoke.json
```

The Ubuntu image was pinned as `ubuntu:24.04` on both CPUs (observed **Ubuntu 24.04.5 LTS**, manifest digest `sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3`). Ubuntu had no Node installation; the smoke container mounted the already downloaded official Node 24.21.0 executable from the Debian test image. This proves the archive's daemon/CLI ran in the tested Ubuntu container, **not an Ubuntu Node installation or fresh-machine setup**. All four final summaries report `completed`, event sequences `[1,2,3]`, and `resultRecovered:true`. An exploratory `ubuntu:latest` x64 run reported Ubuntu 26.04.1 and failed while GNU tar extracted files with `Function not implemented` under emulation; it is outside the pinned Ubuntu 24.04 result and no Gattini runtime result is claimed from it.

## Remaining gate

Task 16's Homebrew tap still needs a real URL/name, named-formula audit, `brew test` and isolated install/upgrade/uninstall. Linux still needs a fresh-host install and native x64 machine check before broad release claims. Windows has no build or transport yet. No tap, extension or npm package was published; no startup service, normal-account Gattini install, provider call, push or merge occurred. The legacy direct-edit gate remains disabled.
