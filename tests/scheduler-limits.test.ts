import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkerScheduler, type WorkerClass } from "../src/daemon/scheduler.js";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function barrier(): { promise: Promise<void>; release: () => void } {
  const gate = deferred<void>();
  return { promise: gate.promise, release: () => gate.resolve() };
}

async function settleScheduler(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

test("one read and one write run together, with FIFO excess admission", async () => {
  const errors: unknown[] = [];
  const scheduler = new WorkerScheduler(() => false, (_jobId, error) => errors.push(error));
  const started: string[] = [];
  const gates = new Map<string, ReturnType<typeof barrier>>();
  const submit = (workerClass: WorkerClass, jobId: string) => {
    const gate = barrier();
    gates.set(jobId, gate);
    scheduler.submit(workerClass, jobId, async () => { started.push(jobId); await gate.promise; });
  };

  submit("read", "read-1");
  submit("read", "read-2");
  submit("read", "read-3");
  submit("write", "write-1");
  submit("write", "write-2");
  submit("write", "write-3");
  await settleScheduler();
  assert.deepEqual(started, ["read-1", "write-1"]);
  assert.deepEqual(scheduler.snapshot(), { queued: ["read-2", "read-3", "write-2", "write-3"],
    activeRead: 1, activeWrite: 1, heldRead: 0, heldWrite: 0 });

  gates.get("read-1")!.release();
  await settleScheduler();
  assert.deepEqual(started, ["read-1", "write-1", "read-2"]);
  assert.deepEqual(scheduler.snapshot(), { queued: ["read-3", "write-2", "write-3"],
    activeRead: 1, activeWrite: 1, heldRead: 0, heldWrite: 0 });

  gates.get("write-1")!.release();
  await settleScheduler();
  assert.deepEqual(started, ["read-1", "write-1", "read-2", "write-2"]);
  assert.deepEqual(scheduler.snapshot().queued, ["read-3", "write-3"]);

  gates.get("read-2")!.release();
  gates.get("write-2")!.release();
  await settleScheduler();
  assert.deepEqual(started, ["read-1", "write-1", "read-2", "write-2", "read-3", "write-3"]);
  assert.deepEqual(scheduler.snapshot().queued, []);

  gates.get("read-3")!.release();
  gates.get("write-3")!.release();
  await settleScheduler();
  assert.deepEqual(scheduler.snapshot(), { queued: [], activeRead: 0, activeWrite: 0, heldRead: 0, heldWrite: 0 });
  assert.deepEqual(errors, []);
});

test("duplicate submissions cannot launch active or queued jobs twice", async () => {
  const scheduler = new WorkerScheduler(() => false, () => assert.fail("Unexpected work error"));
  const gate = barrier();
  const started: string[] = [];
  scheduler.submit("read", "first", async () => { started.push("first"); await gate.promise; });
  scheduler.submit("read", "first", async () => { started.push("duplicate-active"); });
  scheduler.submit("read", "second", async () => { started.push("second"); });
  scheduler.submit("write", "second", async () => { started.push("duplicate-queued"); });
  await settleScheduler();
  assert.deepEqual(started, ["first"]);
  assert.deepEqual(scheduler.snapshot().queued, ["second"]);

  gate.release();
  await settleScheduler();
  assert.deepEqual(started, ["first", "second"]);
  assert.deepEqual(scheduler.snapshot(), { queued: [], activeRead: 0, activeWrite: 0, heldRead: 0, heldWrite: 0 });
});

test("an uncertain held slot blocks its class until explicit release", async () => {
  const scheduler = new WorkerScheduler(jobId => jobId === "uncertain", () => assert.fail("Unexpected work error"));
  const started: string[] = [];
  scheduler.submit("read", "uncertain", async () => { started.push("uncertain"); });
  scheduler.submit("read", "waiting", async () => { started.push("waiting"); });
  scheduler.submit("write", "independent", async () => { started.push("independent"); });
  await settleScheduler();
  assert.deepEqual(started, ["uncertain", "independent"]);
  assert.deepEqual(scheduler.snapshot(), { queued: ["waiting"], activeRead: 0, activeWrite: 0, heldRead: 1, heldWrite: 0 });

  scheduler.submit("read", "uncertain", async () => { started.push("duplicate-held"); });
  await settleScheduler();
  assert.deepEqual(started, ["uncertain", "independent"]);
  assert.deepEqual(scheduler.snapshot().queued, ["waiting"]);

  scheduler.releaseHeld("uncertain");
  await settleScheduler();
  assert.deepEqual(started, ["uncertain", "independent", "waiting"]);
  assert.deepEqual(scheduler.snapshot(), { queued: [], activeRead: 0, activeWrite: 0, heldRead: 0, heldWrite: 0 });
});

test("a recovered held slot blocks admission until release", async () => {
  const scheduler = new WorkerScheduler(() => false, () => assert.fail("Unexpected work error"),
    [{ jobId: "recovered", workerClass: "write" }]);
  const started: string[] = [];
  scheduler.submit("write", "next-write", async () => { started.push("next-write"); });
  scheduler.submit("read", "read", async () => { started.push("read"); });
  await settleScheduler();
  assert.deepEqual(started, ["read"]);
  assert.deepEqual(scheduler.snapshot(), { queued: ["next-write"], activeRead: 0, activeWrite: 0, heldRead: 0, heldWrite: 1 });
  scheduler.releaseHeld("recovered");
  await settleScheduler();
  assert.deepEqual(started, ["read", "next-write"]);
  assert.deepEqual(scheduler.snapshot().queued, []);
});

test("close drops queued work and refuses later submissions", async () => {
  const scheduler = new WorkerScheduler(() => false, () => assert.fail("Unexpected work error"));
  const gate = barrier();
  const started: string[] = [];
  scheduler.submit("read", "active", async () => { started.push("active"); await gate.promise; });
  scheduler.submit("read", "queued", async () => { started.push("queued"); });
  await settleScheduler();
  assert.deepEqual(started, ["active"]);
  assert.deepEqual(scheduler.snapshot().queued, ["queued"]);

  scheduler.close();
  scheduler.submit("write", "late", async () => { started.push("late"); });
  gate.release();
  await settleScheduler();
  assert.deepEqual(started, ["active"]);
  assert.deepEqual(scheduler.snapshot(), { queued: [], activeRead: 0, activeWrite: 0, heldRead: 0, heldWrite: 0 });
});
