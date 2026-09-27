import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectCodeTranscript } from "./helpers/claude-transcript.js";

test("sign-off requires matched successful reads in the exact owned transcript", () => {
  const root = mkdtempSync(join(tmpdir(), "gattini-transcript-"));
  const file = join(root, "session.jsonl"), identity = { sessionId: "owned-session", cwd: root };
  const use = { ...identity, type: "assistant", message: { content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: join(root, "math.mjs") } }] } };
  const result = { ...identity, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: "fixture", is_error: false }] } };
  const check = (events: unknown[]) => { writeFileSync(file, events.map(e => JSON.stringify(e)).join("\n")); return inspectCodeTranscript(file, identity); };
  try {
    assert.equal(check([use, result]).successfulMathReads, 1);
    assert.throws(() => check([]));
    assert.throws(() => check([use]));
    assert.throws(() => check([result]));
    assert.throws(() => check([use, { ...result, sessionId: "other-session" }]));
    assert.throws(() => check([use, { ...result, message: { content: [{ ...result.message.content[0], is_error: true }] } }]));
    assert.throws(() => check([{ ...use, message: { content: [{ ...use.message.content[0], name: "Write" }] } }, result]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
