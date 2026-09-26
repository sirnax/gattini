import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifySnapshot } from "../src/verification/snapshot.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gattini-process-check-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Gattini Test");
  writeFileSync(join(root, "tracked.txt"), "original\n");
  git("add", "tracked.txt"); git("commit", "-qm", "base");
  return { root, baseSha: git("rev-parse", "HEAD") };
}

// A direct-child-only kill leaves inherited output pipes open until the grandchild exits.
test("verification timeout stops descendants holding output pipes", async t => {
  const f = fixture(t);
  const start = performance.now();
  const marker = join(f.root, "late-writer.txt");
  const descendant = `console.log('descendant ready');setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 900);setTimeout(() => {}, 2200);`;
  const evidence = await verifySnapshot({ worktreePath: f.root, baseSha: f.baseSha, commands: [{
    argv: [process.execPath, "-e", `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'inherit'}); setTimeout(() => {}, 10000);`],
    timeoutMs: 400,
  }] });
  assert.match(evidence.checks[0]!.stdout, /descendant ready/);
  assert.equal(evidence.acceptance, "failed");
  assert.equal(evidence.checks[0]!.timedOut, true);
  assert.ok(performance.now() - start < 1800, "descendant must not extend the 400 ms timeout to its 2200 ms lifetime");
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(existsSync(marker), false, "the descendant must be terminated, not merely disconnected");
});

// A successful parent must not turn a still-running background writer into accepted work.
test("successful verification parent cannot leave a background writer running", async t => {
  const f = fixture(t);
  const marker = join(f.root, "late.txt");
  const script = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 1800)`)}],{stdio:'ignore'}); console.log(c.pid); c.unref();`;
  const evidence = await verifySnapshot({ worktreePath: f.root, baseSha: f.baseSha, commands: [{ argv: [process.execPath, "-e", script], timeoutMs: 500 }] });
  const pid = Number(evidence.checks[0]!.stdout.trim());
  t.after(() => { if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ } } });
  assert.equal(evidence.acceptance, "failed");
  assert.notEqual(evidence.checks[0]!.exitCode, 0);
});

test("missing verification executable fails without changing the worktree", async t => {
  const f = fixture(t);
  const evidence = await verifySnapshot({ worktreePath: f.root, baseSha: f.baseSha,
    commands: [{ argv: [join(f.root, "does-not-exist")], timeoutMs: 400 }] });
  assert.equal(evidence.acceptance, "failed");
  assert.equal(evidence.checks[0]!.exitCode, null);
  assert.equal(readFileSync(join(f.root, "tracked.txt"), "utf8"), "original\n");
});

test("escaped descendant holding pipes causes bounded failure instead of acceptance", async t => {
  const f = fixture(t);
  const start = performance.now();
  const script = "const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(() => {}, 2200)'],{detached:true,stdio:'inherit'});console.log(c.pid);c.unref();";
  const evidence = await verifySnapshot({ worktreePath: f.root, baseSha: f.baseSha,
    commands: [{ argv: [process.execPath, "-e", script], timeoutMs: 500 }] });
  const pid = Number(evidence.checks[0]!.stdout.trim());
  t.after(() => { if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ } } });
  assert.equal(evidence.acceptance, "failed");
  assert.equal(evidence.checks[0]!.exitCode, null);
  assert.ok(performance.now() - start < 1800);
});

test("a command that waits for its ordinary subprocess can pass verification", async t => {
  const f = fixture(t);
  const script = "require('node:child_process').execFile(process.execPath,['-e','process.stdout.write(\"child ok\")'],(error,stdout)=>{if(error)process.exit(9);process.stdout.write(stdout)});";
  const evidence = await verifySnapshot({ worktreePath: f.root, baseSha: f.baseSha,
    commands: [{ argv: [process.execPath, "-e", script], timeoutMs: 2000 }] });
  assert.equal(evidence.acceptance, "passed");
  assert.equal(evidence.checks[0]!.stdout, "child ok");
});
