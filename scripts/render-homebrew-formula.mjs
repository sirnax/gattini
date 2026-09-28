#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  throw new Error(message);
}

const args = process.argv.slice(2);
const expected = ["--release-json", "--archive", "--url", "--homepage", "--out"];
if (args.length !== 10 || expected.some((flag, index) => args[index * 2] !== flag)) {
  fail("Usage: node scripts/render-homebrew-formula.mjs --release-json ABS_PATH --archive ABS_PATH --url HTTPS_OR_FILE_URL --homepage HTTPS_URL --out ABS_PATH");
}
const [, releasePath, , archivePath, , suppliedUrl, , suppliedHomepage, , outPath] = args;
for (const path of [releasePath, archivePath, outPath]) {
  if (!isAbsolute(path)) fail("All filesystem paths must be absolute");
}
if (basename(outPath) !== "gattini.rb") fail("Formula output filename must be gattini.rb");
const release = JSON.parse(readFileSync(releasePath, "utf8"));
if (release.name !== "gattini" || !/^\d+\.\d+\.\d+$/.test(release.version) ||
    release.archive !== `gattini-${release.version}.tgz` ||
    release.platform !== "darwin" || release.arch !== "arm64" || release.nodeRange !== ">=24" ||
    !/^[a-f0-9]{64}$/.test(release.sha256)) {
  fail("Release metadata does not match the supported Gattini macOS arm64 package contract");
}
if (basename(archivePath) !== release.archive) fail("Archive filename differs from release metadata");
const actualSha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
if (actualSha256 !== release.sha256) fail("Archive SHA-256 differs from release metadata");

let sourceUrl;
try {
  sourceUrl = new URL(suppliedUrl);
} catch {
  fail("Source URL must be an absolute HTTPS or file URL");
}
if (sourceUrl.protocol !== "https:" && sourceUrl.protocol !== "file:") fail("Source URL must use HTTPS or file");
if (sourceUrl.username || sourceUrl.password || sourceUrl.search || sourceUrl.hash ||
    decodeURIComponent(sourceUrl.pathname.split("/").at(-1)) !== release.archive ||
    /["'\\\n\r#]/.test(suppliedUrl)) {
  fail("Source URL must name the exact archive without credentials, query, fragment, or Ruby syntax");
}
if (sourceUrl.protocol === "file:" && resolve(fileURLToPath(sourceUrl)) !== resolve(archivePath)) {
  fail("Local source URL must point to the verified archive");
}
let homepage;
try {
  homepage = new URL(suppliedHomepage);
} catch {
  fail("Homepage must be an absolute HTTPS URL");
}
if (homepage.protocol !== "https:" || homepage.username || homepage.password || homepage.search || homepage.hash ||
    /["'\\\n\r#]/.test(suppliedHomepage)) {
  fail("Homepage must be an HTTPS URL without credentials, query, fragment, or Ruby syntax");
}

const formula = `# Generated from a checksum-verified Gattini release archive.
require "json"
require "shellwords"

class Gattini < Formula
  desc "Local-first durable AI coding job broker"
  homepage "${suppliedHomepage}"
  url "${suppliedUrl}"
  sha256 "${release.sha256}"
  license "MIT"

  depends_on arch: :arm64
  depends_on :macos
  depends_on "node@24"

  def install
    source = (buildpath/"package/package.json").exist? ? buildpath/"package" : buildpath
    libexec.install source/"package.json", source/"dist", source/"LICENSE", source/"README.md", source/"docs"
    node = formula_opt_bin("node@24")/"node"
    (bin/"gattini").write <<~SH
      #!/bin/sh
      exec "#{node}" "#{libexec}/dist/src/cli/gattini.js" "$@"
    SH
    (bin/"gattinid").write <<~SH
      #!/bin/sh
      exec "#{node}" "#{libexec}/dist/src/daemon/gattinid.js" "$@"
    SH
    chmod 0755, [bin/"gattini", bin/"gattinid"]
  end

  service do
    run opt_bin/"gattinid"
    keep_alive false
  end

  test do
    state = testpath/"state"
    task = testpath/"task with spaces.txt"
    task.write("Homebrew offline fake job\\n")
    ENV["GATTINI_STATE_DIR"] = state.to_s
    pid = spawn((bin/"gattinid").to_s, out: (testpath/"daemon.log").to_s, err: (testpath/"daemon.err").to_s)
    begin
      socket = state/"gattinid.sock"
      100.times do
        break if socket.exist?

        sleep 0.1
      end
      assert_path_exists socket
      command = "#{bin}/gattini run --task-file #{Shellwords.escape(task.to_s)}"
      output = shell_output("#{command} --idempotency-key brew-smoke --role code --json")
      result = JSON.parse(output)
      assert_equal "completed", result.fetch("state")
      assert_equal "unverified", result.fetch("result").fetch("acceptance")
      assert_path_exists state/"jobs.sqlite"
    ensure
      Process.kill("TERM", pid)
      Process.wait(pid)
    end
  end
end
`;
writeFileSync(outPath, formula, { flag: "wx", mode: 0o644 });
process.stdout.write(`${outPath}\n`);
