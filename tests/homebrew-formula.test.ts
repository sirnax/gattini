import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const script = join(process.cwd(), "scripts", "render-homebrew-formula.mjs");

test("local formula pins checked archive, version, platform and Node runtime without lifecycle side effects", () => {
  const root = mkdtempSync(join(tmpdir(), "gattini-formula-"));
  try {
    const archive = join(root, "gattini-0.1.0.tgz");
    writeFileSync(archive, "static fixture archive");
    const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
    const releasePath = join(root, "release.json");
    writeFileSync(releasePath, JSON.stringify({
      name: "gattini", version: "0.1.0", archive: "gattini-0.1.0.tgz", sha256,
      platform: "darwin", arch: "arm64", nodeRange: ">=24",
    }));
    const out = join(root, "Gattini.rb");
    const sourceUrl = pathToFileURL(archive).href;
    const render = (url = sourceUrl, output = out) => spawnSync(process.execPath, [script,
      "--release-json", releasePath, "--archive", archive, "--url", url,
      "--homepage", "https://example.com/gattini", "--out", output,
    ], { encoding: "utf8" });

    assert.equal(render().status, 0);
    const formula = readFileSync(out, "utf8");
    assert.match(formula, /class Gattini < Formula/);
    assert.ok(formula.includes(`url "${sourceUrl}"`));
    assert.ok(formula.includes(`sha256 "${sha256}"`));
    assert.match(formula, /version "0\.1\.0"/);
    assert.match(formula, /depends_on :macos/);
    assert.match(formula, /depends_on arch: :arm64/);
    assert.match(formula, /depends_on "node@24"/);
    assert.match(formula, /dist\/src\/cli\/gattini\.js/);
    assert.match(formula, /dist\/src\/daemon\/gattinid\.js/);
    assert.match(formula, /service do\s+run opt_bin\/"gattinid"\s+keep_alive false/);
    assert.doesNotMatch(formula, /post_install|brew services|launchctl|rm_rf|rmtree|FileUtils\.rm|npm install|claude|opencode|codex/i);
    assert.notEqual(render(sourceUrl, out).status, 0, "existing formula must not be overwritten");

    writeFileSync(archive, "changed archive");
    const mismatch = render(sourceUrl, join(root, "mismatch.rb"));
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /SHA-256 differs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
