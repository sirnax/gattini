import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { startDaemon } from "../src/daemon/server.js";

function rpc(socketPath: string, method: string, params: Record<string, unknown>, protocolVersion = 2): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let output = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ protocolVersion, clientVersion: "0.2.0", requestId: "test", method, params }) + "\n"));
    socket.on("data", chunk => { output += chunk; });
    socket.on("end", () => { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } });
    socket.on("error", reject);
  });
}

test("v2 hello, bounded event replay and restart retain the exact cursor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gattini v2 spaced state "));
  let daemon = await startDaemon(directory);
  try {
    const hello = await rpc(daemon.socketPath, "hello", {});
    assert.deepEqual([hello.result.version, hello.result.protocolVersion], ["0.2.0", 2]);
    const started = await rpc(daemon.socketPath, "start", { task: "private task content", idempotencyKey: "v2-once", role: "code" });
    assert.equal(started.ok, true, JSON.stringify(started));
    const jobId = started.result.jobId as string;
    const first = await rpc(daemon.socketPath, "events.list", { jobId, afterSequence: 0, limit: 1 });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.result.events.length, 1);
    assert.equal(first.result.events[0].sequence, 1);
    assert.equal(first.result.nextSequence, 1);
    assert.equal(first.result.hasMore, true);
    assert.equal(JSON.stringify(first).includes("private task content"), false);
    const duplicate = await rpc(daemon.socketPath, "events.list", { jobId, afterSequence: 0, limit: 1 });
    assert.deepEqual(duplicate.result, first.result);
    await daemon.close();
    daemon = await startDaemon(directory);
    const second = await rpc(daemon.socketPath, "events.list", { jobId, afterSequence: 1, limit: 100 });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.deepEqual(second.result.events.map((event: { sequence: number }) => event.sequence), [2, 3]);
    assert.equal(second.result.nextSequence, 3);
    assert.equal(second.result.hasMore, false);
    const empty = await rpc(daemon.socketPath, "events.list", { jobId, afterSequence: 3, limit: 100 });
    assert.deepEqual([empty.result.events, empty.result.nextSequence, empty.result.hasMore], [[], 3, false]);
    const future = await rpc(daemon.socketPath, "events.list", { jobId, afterSequence: 4, limit: 1 });
    assert.equal(future.error.code, "CURSOR_FUTURE");
    for (const cursor of [-1, 1.5, "1", null, {}, Number.MAX_SAFE_INTEGER + 1]) {
      const malformed = await rpc(daemon.socketPath, "events.list", { jobId, afterSequence: cursor, limit: 1 });
      assert.equal(malformed.error.code, "INVALID_CURSOR");
    }
    for (const limit of [0, 101, "5"]) {
      const malformed = await rpc(daemon.socketPath, "events.list", { jobId, afterSequence: 0, limit });
      assert.equal(malformed.error.code, "INVALID_CURSOR");
    }
    const missing = await rpc(daemon.socketPath, "events.list", { jobId: "missing", afterSequence: 0, limit: 1 });
    assert.equal(missing.error.code, "NOT_FOUND");
    const legacy = await rpc(daemon.socketPath, "events.list", { jobId, afterSequence: 0, limit: 1 }, 1);
    assert.equal(legacy.error.code, "PROTOCOL_MISMATCH");
    const db = new DatabaseSync(join(directory, "jobs.sqlite"));
    db.prepare("DELETE FROM events WHERE job_id = ? AND sequence = 2").run(jobId);
    db.close();
    const gap = await rpc(daemon.socketPath, "events.list", { jobId, afterSequence: 1, limit: 100 });
    assert.equal(gap.error.code, "EVENT_GAP");
  } finally {
    await daemon.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
