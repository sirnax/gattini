import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { SnapshotEvidence } from "../src/core/coding.js";
import { buildPinnedReviewPrompt, PinnedReviewError } from "../src/verification/pinned-review.js";

const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

async function fixture(): Promise<{ root: string; evidence: SnapshotEvidence; sourcePath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gattini-pinned-review-"));
  const sourcePath = path.join(root, "coding-worktree", "source.txt");
  const snapshotPath = path.join(root, "snapshot.json");
  const diffPath = path.join(root, "diff.patch");
  const snapshotSha = sha("tree digest");
  const diffSha256 = sha("diff digest");
  const snapshot = JSON.stringify({ schemaVersion: 1, snapshotSha, diffSha256, changedFiles: ["source.txt"],
    entries: [{ path: "source.txt", kind: "file", mode: 33188, content: Buffer.from("pinned version\n").toString("base64") }] });
  const diff = "diff --git a/source.txt b/source.txt\n+ pinned version\n";
  await writeFile(snapshotPath, snapshot);
  await writeFile(diffPath, diff);
  const evidence: SnapshotEvidence = { worktreePath: path.dirname(sourcePath), baseSha: sha("base"), snapshotSha, diffSha256,
    changedFiles: ["source.txt"], checks: [], acceptance: "passed", limitations: [],
    artifact: { path: snapshotPath, sha256: sha(snapshot), diffPath, diffFileSha256: sha(diff) } };
  return { root, evidence, sourcePath };
}

async function withFixture(run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>): Promise<void> {
  const value = await fixture();
  try { await run(value); } finally { await rm(value.root, { recursive: true, force: true }); }
}

function assertCode(code: "EVIDENCE_INVALID" | "SNAPSHOT_TOO_LARGE") {
  return (error: unknown): boolean => error instanceof PinnedReviewError && error.code === code;
}

test("review prompt stays pinned after the coding worktree changes", async () => withFixture(async ({ evidence, sourcePath }) => {
  const before = await buildPinnedReviewPrompt(evidence);
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, "later mutable version\n");
  const after = await buildPinnedReviewPrompt(evidence);
  assert.equal(after, before);
  assert.match(after, /pinned version/);
  assert.doesNotMatch(after, /later mutable version/);
  assert.equal(after.includes(evidence.worktreePath), false);
}));

test("modified retained bytes fail the artifact digest check", async () => withFixture(async ({ evidence }) => {
  await writeFile(evidence.artifact!.diffPath, "tampered patch\n");
  await assert.rejects(buildPinnedReviewPrompt(evidence), assertCode("EVIDENCE_INVALID"));
}));

test("a rehashed artifact with a different snapshot identity is rejected", async () => withFixture(async ({ evidence }) => {
  const artifact = evidence.artifact!;
  const changed = (await readFile(artifact.path, "utf8")).replace(evidence.snapshotSha, sha("other snapshot"));
  await writeFile(artifact.path, changed);
  const forged = { ...evidence, artifact: { ...artifact, sha256: sha(changed) } };
  await assert.rejects(buildPinnedReviewPrompt(forged), assertCode("EVIDENCE_INVALID"));
}));

test("review input exceeding its byte budget is rejected", async () => withFixture(async ({ evidence }) => {
  await assert.rejects(buildPinnedReviewPrompt(evidence, { maxInputBytes: 128 }), assertCode("SNAPSHOT_TOO_LARGE"));
}));

test("absolute coding worktree path embedded in retained data is rejected", async () => withFixture(async ({ evidence }) => {
  const artifact = evidence.artifact!;
  const changed = (await readFile(artifact.path, "utf8")).replace("source.txt", evidence.worktreePath);
  await writeFile(artifact.path, changed);
  const pathEvidence = { ...evidence, changedFiles: [evidence.worktreePath], artifact: { ...artifact, sha256: sha(changed) } };
  await assert.rejects(buildPinnedReviewPrompt(pathEvidence), assertCode("EVIDENCE_INVALID"));
}));
