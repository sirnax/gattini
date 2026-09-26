#!/usr/bin/env node
/** Offline Task 9 proposal apply. The trusted coding daemon route remains disabled. */
import { readFileSync, statSync } from "node:fs";
import { applyValidatedPatch, validatePatch } from "../verification/validated-patch.js";
import { parseVerificationCommands } from "../core/coding.js";
import { verifySnapshot } from "../verification/snapshot.js";
import { WorktreeManager } from "../environments/worktree.js";

async function main(args: string[]): Promise<void> {
  if (args.length !== 4) throw new Error("Usage: node dist/src/cli/gattini-apply-patch.js PRIVATE_STATE_DIR OWNED_JOB_ID PROPOSAL_JSON_FILE CHECKS_JSON_FILE");
  const [stateDir, jobId, proposalFile, checksFile] = args as [string, string, string, string];
  const manager = new WorktreeManager(stateDir);
  const owned = manager.get(jobId);
  manager.close();
  if (!owned || owned.state !== "ready") throw new Error("Ready owned worktree record required");
  const { worktreePath: worktree, baseSha } = owned;
  if (statSync(proposalFile).size > 1024 * 1024 || statSync(checksFile).size > 16 * 1024) throw new Error("Proposal or checks file exceeds limit");
  const proposal = readFileSync(proposalFile, "utf8");
  const checks = parseVerificationCommands(JSON.parse(readFileSync(checksFile, "utf8")) as unknown);
  const validated = validatePatch(proposal, worktree, baseSha);
  const applied = applyValidatedPatch(validated);
  const evidence = await verifySnapshot({ worktreePath: worktree, baseSha, commands: checks });
  process.stdout.write(`${JSON.stringify({ applied, evidence })}\n`);
  if (evidence.acceptance !== "passed") process.exitCode = 1;
}

main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : "Patch apply failed"}\n`);
  process.exitCode = 2;
});
