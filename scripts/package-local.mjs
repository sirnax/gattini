#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

process.umask(0o077);
const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out-dir" || !isAbsolute(args[1])) {
  throw new Error("Usage: node scripts/package-local.mjs --out-dir ABSOLUTE_DIRECTORY");
}
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The local release is validated only for macOS arm64");
}
if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node 24 or newer is required");

const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const releaseSource = readFileSync(join(root, "src/core/release.ts"), "utf8");
if (source.version !== lock.version || source.version !== lock.packages?.[""]?.version ||
    !releaseSource.includes(`RELEASE_VERSION = "${source.version}"`)) {
  throw new Error("Release version differs between package.json, lockfile, and protocol");
}
if (source.engines?.node !== ">=24" || Object.keys(source.dependencies ?? {}).length !== 0) {
  throw new Error("Unexpected runtime dependency or Node engine range");
}
for (const [name, pinned] of Object.entries(source.devDependencies ?? {})) {
  if (!/^\d+\.\d+\.\d+$/.test(pinned) || lock.packages?.[`node_modules/${name}`]?.version !== pinned) {
    throw new Error(`Unpinned or unlocked development dependency: ${name}`);
  }
  const installed = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8"));
  if (installed.version !== pinned) throw new Error(`Installed build dependency differs from lockfile: ${name}`);
}

const out = args[1];
mkdirSync(out, { recursive: true, mode: 0o700 });
const archive = `${source.name}-${source.version}.tgz`;
for (const file of [archive, `${archive}.sha256`, "release.json"]) {
  if (existsSync(join(out, file))) throw new Error(`Release output already exists: ${file}`);
}
const temporary = mkdtempSync(join(tmpdir(), "gattini-package-"));
try {
  const built = join(temporary, "built");
  const compiler = join(root, "node_modules", ".bin", "tsc");
  const result = spawnSync(compiler, ["-p", join(root, "tsconfig.json"), "--outDir", built],
    { cwd: root, encoding: "utf8", timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error(`TypeScript build failed: ${result.error ?? result.stderr}`);

  const stage = join(temporary, "stage");
  mkdirSync(join(stage, "dist"), { recursive: true });
  cpSync(join(built, "src"), join(stage, "dist", "src"), { recursive: true });
  cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));
  cpSync(join(root, "README.md"), join(stage, "README.md"));
  mkdirSync(join(stage, "docs"));
  cpSync(join(root, "docs", "installation.md"), join(stage, "docs", "installation.md"));
  const manifest = {
    name: source.name,
    version: source.version,
    type: "module",
    license: source.license,
    engines: source.engines,
    os: ["darwin"],
    cpu: ["arm64"],
    bin: source.bin,
    files: ["dist/src", "LICENSE", "README.md", "docs/installation.md"],
  };
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const npm = spawnSync("npm", ["pack", stage, "--pack-destination", out, "--json", "--offline", "--ignore-scripts"],
    { cwd: root, encoding: "utf8", timeout: 120_000,
      env: { ...process.env, npm_config_cache: join(temporary, "npm-cache"), npm_config_update_notifier: "false" } });
  if (npm.error || npm.status !== 0) throw new Error(`npm pack failed: ${npm.error ?? npm.stderr}`);
  const packed = JSON.parse(npm.stdout);
  if (!Array.isArray(packed) || packed.length !== 1 || packed[0]?.filename !== archive) {
    throw new Error("npm pack returned an unexpected archive");
  }
  const sha256 = createHash("sha256").update(readFileSync(join(out, archive))).digest("hex");
  writeFileSync(join(out, `${archive}.sha256`), `${sha256}  ${archive}\n`);
  writeFileSync(join(out, "release.json"), `${JSON.stringify({
    name: source.name, version: source.version, archive, sha256,
    platform: process.platform, arch: process.arch, nodeRange: source.engines.node,
  }, null, 2)}\n`);
  process.stdout.write(`${join(out, archive)}\n${sha256}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
