import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { runReviewFollowup, type OpenCodeCliEvent, type ReviewRole } from "../src/adapters/opencode-cli.js";

const savedSessionId = "ses_saved123";

function fakeCli(mode: string): { directory: string; calls: string; restore(): void } {
  const directory = mkdtempSync(join(tmpdir(), "gattini-followup-"));
  const bin = join(directory, "bin");
  const calls = join(directory, "calls");
  mkdirSync(bin);
  const executable = join(bin, "opencode");
  writeFileSync(executable, `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_FOLLOWUP_CALLS"
case "$FAKE_FOLLOWUP_MODE" in
  success)
    printf '%s\\n' '{"type":"step_start","sessionID":"ses_saved123"}'
    printf '%s\\n' '{"type":"text","sessionID":"ses_saved123","part":{"text":"Follow-up complete."}}' ;;
  wrong-id)
    printf '%s\\n' '{"type":"step_start","sessionID":"ses_saved123"}'
    printf '%s\\n' '{"type":"text","sessionID":"ses_other456","part":{"text":"Wrong session."}}' ;;
  missing-id)
    printf '%s\\n' '{"type":"text","part":{"text":"Unbound text."}}' ;;
  no-text)
    printf '%s\\n' '{"type":"step_start","sessionID":"ses_saved123"}' ;;
esac
`, { mode: 0o700 });
  chmodSync(executable, 0o700);
  const original = { path: process.env.PATH, calls: process.env.FAKE_FOLLOWUP_CALLS, mode: process.env.FAKE_FOLLOWUP_MODE };
  process.env.PATH = `${bin}${delimiter}${original.path ?? ""}`;
  process.env.FAKE_FOLLOWUP_CALLS = calls;
  process.env.FAKE_FOLLOWUP_MODE = mode;
  return { directory, calls, restore() {
    for (const [name, value] of [["PATH", original.path], ["FAKE_FOLLOWUP_CALLS", original.calls], ["FAKE_FOLLOWUP_MODE", original.mode]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  } };
}

function role(directory: string): ReviewRole {
  return { runtime: "opencode", agent: "reviewer", model: "provider/model", directory, serverUrl: "http://127.0.0.1:4096", permissions: [] };
}

test("follow-up passes the exact session and explicit role arguments", async () => {
  const fixture = fakeCli("success");
  try {
    const events: OpenCodeCliEvent[] = [];
    const result = await runReviewFollowup(role(fixture.directory), savedSessionId, "Inspect the second turn", event => events.push(event));
    assert.deepEqual(result, { sessionId: savedSessionId, summary: "Follow-up complete." });
    assert.deepEqual(events.map(event => event.type), ["step_start", "text"]);
    assert.deepEqual(readFileSync(fixture.calls, "utf8").trimEnd().split("\n"), [
      "run", "--session", savedSessionId, "--agent", "reviewer", "--model", "provider/model", "--format", "json", "Inspect the second turn",
    ]);
  } finally { fixture.restore(); }
});

test("follow-up rejects wrong or missing event session IDs", async () => {
  for (const mode of ["wrong-id", "missing-id"]) {
    const fixture = fakeCli(mode);
    try {
      const events: OpenCodeCliEvent[] = [];
      await assert.rejects(runReviewFollowup(role(fixture.directory), savedSessionId, "Continue", event => events.push(event)), /missing or mismatched session ID/);
      assert.equal(events.length, mode === "wrong-id" ? 1 : 0);
    } finally { fixture.restore(); }
  }
});

test("follow-up rejects a stream without final text and invalid saved IDs before launch", async () => {
  const fixture = fakeCli("no-text");
  try {
    await assert.rejects(runReviewFollowup(role(fixture.directory), savedSessionId, "Continue", () => {}), /omitted session ID or final text/);
    rmSync(fixture.calls);
    for (const invalid of ["", "ses_bad-id", "--session", "ses_bad\nvalue"]) {
      await assert.rejects(runReviewFollowup(role(fixture.directory), invalid, "Continue", () => {}), /Invalid OpenCode session ID/);
      assert.equal(existsSync(fixture.calls), false);
    }
  } finally { fixture.restore(); }
});
