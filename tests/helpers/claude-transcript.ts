import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Read only one exact session file. Provider content is data, never instructions. */
export function inspectCodeTranscript(file: string, identity: { sessionId: string; cwd: string }): any {
  assert.ok(statSync(file).size <= 4_000_000, "transcript exceeds evidence limit");
  const raw = readFileSync(file, "utf8"), pending = new Map<string, { name: string; path: string | null }>();
  const seen = new Set<string>(), completed: Array<{ name: string; path: string | null }> = [];
  const lines = raw.split("\n").filter(Boolean); assert.ok(lines.length <= 10_000);
  for (const line of lines) {
    const event = JSON.parse(line);
    if (!["assistant", "user"].includes(event.type)) continue;
    assert.equal(event.sessionId, identity.sessionId, "transcript session mismatch");
    assert.equal(event.cwd, identity.cwd, "transcript cwd mismatch");
    if (!Array.isArray(event.message?.content)) continue; // Original user prompt is a string.
    for (const block of event.message.content) {
      if (block.type === "tool_use") {
        assert.ok(["Read", "Glob", "Grep"].includes(block.name), "disallowed transcript tool");
        assert.equal(typeof block.id, "string"); assert.ok(!seen.has(block.id), "duplicate tool use");
        seen.add(block.id); pending.set(block.id, { name: block.name, path: block.input?.file_path ?? null });
      } else if (block.type === "tool_result") {
        const tool = pending.get(block.tool_use_id); assert.ok(tool, "unmatched tool result");
        assert.ok(block.is_error === undefined || block.is_error === false, "failed or denied tool result");
        completed.push(tool); pending.delete(block.tool_use_id);
      }
    }
  }
  assert.equal(pending.size, 0, "unfinished tool call");
  const successfulMathReads = completed.filter(tool => tool.name === "Read" && tool.path === join(identity.cwd, "math.mjs")).length;
  assert.ok(successfulMathReads > 0, "no successful Read of the owned math.mjs");
  return { path: file, sha256: createHash("sha256").update(raw).digest("hex"), successfulMathReads, completed };
}
