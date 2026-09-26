import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { JobStore } from "./store.js";
import { WorkerScheduler } from "./scheduler.js";
import { isTransientPreflightFailure, MAX_PREFLIGHT_ATTEMPTS } from "./retry.js";
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION, ProtocolError, parseRequest, stringParam, type Request, type Response } from "../core/protocol.js";
import { parseRoleConfig } from "../core/role-config.js";
import { enforceReviewerPolicy } from "../core/policy.js";
import { getReviewSession, interruptReview, isReviewSessionActive, preflightReview, runReview, runReviewFollowup, type ReviewRole } from "../adapters/opencode-cli.js";
import { parseCodeRoleConfig } from "../core/code-policy.js";
import { parseVerificationCommands, type CodeJobInput, type CodeRoleConfig } from "../core/coding.js";
import { getCodeSession, interruptCode, preflightProposal, runProposal } from "../adapters/opencode-code.js";
import { WorktreeError, WorktreeManager } from "../environments/worktree.js";
import { snapshotFingerprint, verifySnapshot } from "../verification/snapshot.js";
import { applyValidatedPatch, validatePatch } from "../verification/validated-patch.js";
import { buildPinnedReviewPrompt, PinnedReviewError } from "../verification/pinned-review.js";
import { previewOwnedCleanup } from "../environments/cleanup-preview.js";

export function stateDirectory(): string {
  const override = process.env.GATTINI_STATE_DIR;
  if (override) {
    if (!isAbsolute(override)) throw new Error("GATTINI_STATE_DIR must be absolute");
    return override;
  }
  return join(homedir(), "Library", "Application Support", "Gattini");
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error("Gattini state directory must be a private, user-owned directory (0700)");
  }
}

async function clearStaleSocket(path: string): Promise<void> {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error("Socket path exists and is not a user-owned socket");
  const active = await new Promise<boolean>((resolve, reject) => {
    const probe = createConnection(path);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", error => {
      if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
  if (active) throw new Error("Gattini daemon is already running");
  unlinkSync(path);
}

function exactParams(params: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(params).some(key => !keys.includes(key))) throw new ProtocolError("INVALID_REQUEST", "Unknown parameter");
}

type ScheduleReview = (jobId: string, task: string, config: ReviewRole) => void;
type ScheduleFollowup = (jobId: string, attemptId: string, task: string, config: ReviewRole, sessionId: string) => void;
type ScheduleCancellation = (jobId: string, config: ReviewRole, sessionId: string) => void;
type ScheduleCode = (jobId: string, input: CodeJobInput, config: CodeRoleConfig, worktreePath: string) => void;
type ScheduleCodeCancellation = (jobId: string, config: CodeRoleConfig, worktreePath: string, sessionId: string) => void;
type ScheduleApply = (jobId: string, input: CodeJobInput, config: CodeRoleConfig, worktreePath: string, proposal: string, sessionId: string) => void;

async function dispatch(store: JobStore, worktrees: WorktreeManager, request: Request, directory: string,
  scheduleReview: ScheduleReview, scheduleFollowup: ScheduleFollowup, scheduleCancellation: ScheduleCancellation, scheduleCode: ScheduleCode,
  scheduleCodeCancellation: ScheduleCodeCancellation, scheduleApply: ScheduleApply): Promise<unknown> {
  const params = request.params;
  if (request.method === "cleanup.preview") {
    exactParams(params, ["jobId"]);
    const jobId = params.jobId === undefined ? undefined : stringParam(params, "jobId", 128);
    try { return previewOwnedCleanup(worktrees, id => store.status(id).state, jobId); }
    catch (error) {
      if (error instanceof WorktreeError) throw new ProtocolError("NOT_FOUND", "Cleanup ownership record was not found");
      throw error;
    }
  }
  if (request.method === "followup") {
    exactParams(params, ["jobId", "task", "idempotencyKey"]);
    const jobId = stringParam(params, "jobId", 128);
    const task = stringParam(params, "task", 16_384);
    const idempotencyKey = stringParam(params, "idempotencyKey", 128);
    const enqueued = store.enqueueFollowup(jobId, task, idempotencyKey);
    if (!enqueued.deduplicated) {
      const status = store.status(jobId);
      const config = enforceReviewerPolicy(parseRoleConfig({ schemaVersion: 1, roles: { reviewer: store.reviewConfig(jobId) } }).roles.reviewer);
      if (!status.runtimeSessionId) throw new ProtocolError("UNSUPPORTED_FOLLOWUP", "Saved exact session is unavailable");
      scheduleFollowup(jobId, enqueued.attemptId, task, config, status.runtimeSessionId);
    }
    return enqueued;
  }
  if (request.method === "review") {
    exactParams(params, ["jobId", "idempotencyKey"]);
    const sourceJobId = stringParam(params, "jobId", 128);
    const idempotencyKey = stringParam(params, "idempotencyKey", 128);
    const { attemptId, snapshot } = store.sourceSnapshotForReview(sourceJobId);
    let config: ReviewRole;
    try { config = enforceReviewerPolicy(parseRoleConfig(JSON.parse(readFileSync(join(directory, "roles.json"), "utf8"))).roles.reviewer); }
    catch { throw new ProtocolError("CONFIG_INVALID", "A valid private roles.json is required for review"); }
    const reviewDirectory = realpathSync(config.directory);
    const codingWorktree = realpathSync(snapshot.worktreePath);
    if (reviewDirectory === codingWorktree || reviewDirectory.startsWith(`${codingWorktree}${sep}`)) {
      throw new ProtocolError("UNSUPPORTED_REVIEW", "Reviewer directory must be outside the coding worktree");
    }
    let task: string;
    try { task = await buildPinnedReviewPrompt(snapshot, { maxInputBytes: 12 * 1024 }); }
    catch (error) {
      if (error instanceof PinnedReviewError) throw new ProtocolError(error.code, error.message);
      throw error;
    }
    const enqueued = store.enqueueReview({ task, idempotencyKey, role: "reviewer", config,
      pinnedSource: { jobId: sourceJobId, attemptId, snapshotSha: snapshot.snapshotSha, diffSha256: snapshot.diffSha256 } });
    if (!enqueued.deduplicated && enqueued.state === "queued") scheduleReview(enqueued.jobId, task, config);
    return { ...enqueued, sourceJobId, sourceAttemptId: attemptId, snapshotSha: snapshot.snapshotSha, diffSha256: snapshot.diffSha256 };
  }
  if (request.method === "start") {
    exactParams(params, ["task", "idempotencyKey", "role", "requireApproval", "trustedLocal", "repositoryPath", "baseSha", "verificationCommands"]);
    if (params.requireApproval !== undefined && typeof params.requireApproval !== "boolean") throw new ProtocolError("INVALID_REQUEST", "requireApproval must be boolean");
    const task = stringParam(params, "task", 16_384);
    const idempotencyKey = stringParam(params, "idempotencyKey", 128);
    const role = stringParam(params, "role", 128);
    if (params.trustedLocal === true) {
      if (role !== "code" || params.requireApproval !== true) throw new ProtocolError("UNSUPPORTED_POLICY", "Trusted coding requires the code role and exact launch approval");
      let config: CodeRoleConfig;
      try { config = parseCodeRoleConfig(JSON.parse(readFileSync(join(directory, "code-role.json"), "utf8"))); }
      catch { throw new ProtocolError("CONFIG_INVALID", "A valid private code-role.json is required for trusted coding"); }
      let verificationCommands;
      try { verificationCommands = parseVerificationCommands(params.verificationCommands); }
      catch { throw new ProtocolError("INVALID_REQUEST", "Invalid verification commands"); }
      const input: CodeJobInput = { task, idempotencyKey, repositoryPath: stringParam(params, "repositoryPath", 4096),
        baseSha: stringParam(params, "baseSha", 128), verificationCommands, trustedLocal: true };
      return store.enqueueCode(input, config, worktrees);
    }
    if (params.trustedLocal !== undefined || params.repositoryPath !== undefined || params.baseSha !== undefined || params.verificationCommands !== undefined) {
      throw new ProtocolError("INVALID_REQUEST", "Coding repository fields require trustedLocal true");
    }
    if (role === "reviewer") {
      let config: ReviewRole;
      try { config = enforceReviewerPolicy(parseRoleConfig(JSON.parse(readFileSync(join(directory, "roles.json"), "utf8"))).roles.reviewer); }
      catch { throw new ProtocolError("CONFIG_INVALID", "A valid private roles.json is required for reviewer jobs"); }
      const enqueued = store.enqueueReview({ task, idempotencyKey, role, config, requireApproval: params.requireApproval === true });
      if (!enqueued.deduplicated && enqueued.state === "queued") scheduleReview(enqueued.jobId, task, config);
      return enqueued;
    }
    if (role !== "code") throw new ProtocolError("INVALID_REQUEST", "Only code (fake) and reviewer (OpenCode) roles are supported");
    if (params.requireApproval === true) throw new ProtocolError("UNSUPPORTED_POLICY", "The fake code role has no approval-gated runtime action");
    return store.start({ task, idempotencyKey, role });
  }
  if (request.method === "approvals.list") {
    exactParams(params, []);
    return store.approvals();
  }
  if (request.method === "approve" || request.method === "deny") {
    exactParams(params, ["approvalId"]);
    const approvalId = stringParam(params, "approvalId", 128);
    const outcome = store.decideApproval(approvalId, request.method === "approve" ? "approved" : "denied", `uid:${process.getuid?.() ?? "unknown"}`);
    if (outcome.launch) scheduleReview(outcome.jobId, outcome.launch.task, enforceReviewerPolicy(outcome.launch.config));
    if (outcome.codeLaunch) scheduleCode(outcome.jobId, outcome.codeLaunch.input, outcome.codeLaunch.config, outcome.codeLaunch.worktreePath);
    if (outcome.codeApply) scheduleApply(outcome.jobId, outcome.codeApply.input, outcome.codeApply.config, outcome.codeApply.worktreePath, outcome.codeApply.proposal, outcome.codeApply.sessionId);
    return { approvalId: outcome.approvalId, jobId: outcome.jobId, state: outcome.state };
  }
  exactParams(params, request.method === "result" ? ["jobId", "attemptId"] : ["jobId"]);
  const jobId = stringParam(params, "jobId", 128);
  if (request.method === "status") return store.status(jobId);
  if (request.method === "cancel") {
    const cancellation = store.requestCancel(jobId);
    if (cancellation.state === "cancelling" && cancellation.runtimeSessionId && cancellation.config) {
      const codePath = store.codeWorktreePath(jobId);
      if (codePath) scheduleCodeCancellation(jobId, parseCodeRoleConfig({ ...(cancellation.config as object), runtime: "opencode" }), codePath, cancellation.runtimeSessionId);
      else {
        const config = parseRoleConfig({ schemaVersion: 1, roles: { reviewer: cancellation.config } }).roles.reviewer;
        scheduleCancellation(jobId, config, cancellation.runtimeSessionId);
      }
    }
    return { jobId, state: cancellation.state };
  }
  return store.result(jobId, params.attemptId === undefined ? undefined : stringParam(params, "attemptId", 128));
}

function handleConnection(socket: Socket, store: JobStore, worktrees: WorktreeManager, directory: string, scheduleReview: ScheduleReview,
  scheduleFollowup: ScheduleFollowup, scheduleCancellation: ScheduleCancellation, scheduleCode: ScheduleCode, scheduleCodeCancellation: ScheduleCodeCancellation, scheduleApply: ScheduleApply): void {
  socket.setTimeout(10_000, () => socket.destroy());
  let buffer = Buffer.alloc(0);
  let answered = false;
  const reply = (response: Response): void => {
    if (answered) return;
    answered = true;
    socket.end(JSON.stringify(response) + "\n");
  };
  socket.on("data", chunk => {
    if (answered) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_MESSAGE_BYTES) {
      reply({ protocolVersion: PROTOCOL_VERSION, requestId: "", ok: false, error: { code: "MESSAGE_TOO_LARGE", message: "Request exceeds 1 MiB" } });
      return;
    }
    const end = buffer.indexOf(10);
    if (end < 0) return;
    let requestId = "";
    try {
      const request = parseRequest(JSON.parse(buffer.subarray(0, end).toString("utf8")));
      requestId = request.requestId;
      void dispatch(store, worktrees, request, directory, scheduleReview, scheduleFollowup, scheduleCancellation, scheduleCode, scheduleCodeCancellation, scheduleApply)
        .then(result => reply({ protocolVersion: PROTOCOL_VERSION, requestId, ok: true, result }))
        .catch(error => reply({ protocolVersion: PROTOCOL_VERSION, requestId, ok: false,
          error: { code: error instanceof ProtocolError ? error.code : "INTERNAL", message: error instanceof ProtocolError ? error.message : "Internal daemon error" } }));
    } catch (error) {
      const known = error instanceof ProtocolError ? error
        : error instanceof SyntaxError ? new ProtocolError("INVALID_REQUEST", "Malformed JSON request")
        : undefined;
      reply({ protocolVersion: PROTOCOL_VERSION, requestId: known?.requestId || requestId, ok: false,
        error: { code: known?.code ?? "INTERNAL", message: known?.message ?? "Internal daemon error" } });
    }
  });
  socket.on("error", () => { /* Client disconnect does not cancel a persisted job. */ });
}

export interface RunningDaemon {
  socketPath: string;
  close(): Promise<void>;
}

export async function startDaemon(directory = stateDirectory()): Promise<RunningDaemon> {
  ensurePrivateDirectory(directory);
  const socketPath = join(directory, "gattinid.sock");
  await clearStaleSocket(socketPath);
  const store = new JobStore(join(directory, "jobs.sqlite"));
  const worktrees = new WorktreeManager(directory);
  const activeReviews = new Set<Promise<void>>();
  const cancellations = new Set<string>();
  const localClients = new Map<string, AbortController>();
  const scheduler = new WorkerScheduler(jobId => ["interrupted", "cancelling"].includes(store.status(jobId).state),
    () => { /* Each scheduled path records its own failure state. */ }, store.uncertainCapacity());
  const scheduleCancellation: ScheduleCancellation = (jobId, config, sessionId) => {
    if (cancellations.has(jobId)) return;
    cancellations.add(jobId);
    const work = interruptReview(config, sessionId)
      .then(confirmed => { if (confirmed) { store.confirmCancelled(jobId, sessionId); scheduler.releaseHeld(jobId); } else store.cancelUncertain(jobId); })
      .catch(() => store.cancelUncertain(jobId))
      .finally(() => localClients.get(jobId)?.abort());
    activeReviews.add(work);
    void work.finally(() => { cancellations.delete(jobId); activeReviews.delete(work); });
  };
  const scheduleReview: ScheduleReview = (jobId, task, config) => {
    scheduler.submit("read", jobId, async () => {
      let attemptId: string | undefined;
      const work = (async () => {
        const pinned = store.pinnedReviewSnapshot(jobId);
        const before = pinned ? await snapshotFingerprint(pinned.worktreePath, pinned.baseSha) : null;
        let failures = store.preflightFailureCount(jobId);
        for (;;) {
          try { await preflightReview(config); break; }
          catch (error) {
            if (!isTransientPreflightFailure(error)) throw error;
            failures += 1;
            store.recordTransientPreflightFailure(jobId, failures >= MAX_PREFLIGHT_ATTEMPTS);
            if (failures >= MAX_PREFLIGHT_ATTEMPTS) return;
          }
        }
        attemptId = store.claimReview(jobId);
        const localClient = new AbortController();
        localClients.set(jobId, localClient);
        const launched = await runReview(config, task, event => {
          store.recordReviewEvent(jobId, attemptId!, event);
          if (event.sessionID && store.cancellationNeeded(jobId)) scheduleCancellation(jobId, config, event.sessionID);
        }, localClient.signal, store.runtimeTimeoutMs(jobId));
        const session = await getReviewSession(config, launched.sessionId);
        const expectedModel = `${session.model.providerID}/${session.model.id}`;
        if (session.agent !== config.agent || expectedModel !== config.model || session.outcome !== "succeeded" || session.directory !== config.directory) {
          throw new Error("OpenCode session resolved identity or outcome differs from request");
        }
        if (pinned && before !== await snapshotFingerprint(pinned.worktreePath, pinned.baseSha)) {
          throw new Error("Coding worktree changed during independent review");
        }
        store.completeReview(jobId, attemptId, launched.sessionId, launched.summary, {
          runtimeVersion: "2.0.16", agent: session.agent, model: expectedModel,
        });
      })().catch(() => { store.failReview(jobId, attemptId); }).finally(() => localClients.delete(jobId));
      activeReviews.add(work);
      try { await work; } finally { activeReviews.delete(work); }
    });
  };
  const scheduleFollowup: ScheduleFollowup = (jobId, attemptId, task, config, sessionId) => {
    scheduler.submit("read", jobId, async () => {
      let claimed = false;
      const work = (async () => {
        await preflightReview(config);
        store.claimFollowup(jobId, attemptId, sessionId);
        claimed = true;
        const localClient = new AbortController();
        localClients.set(jobId, localClient);
        const launched = await runReviewFollowup(config, sessionId, task, event => {
          store.recordReviewEvent(jobId, attemptId, event);
          if (store.cancellationNeeded(jobId)) scheduleCancellation(jobId, config, sessionId);
        }, localClient.signal, store.runtimeTimeoutMs(jobId));
        const session = await getReviewSession(config, launched.sessionId);
        const expectedModel = `${session.model.providerID}/${session.model.id}`;
        if (launched.sessionId !== sessionId || session.agent !== config.agent || expectedModel !== config.model ||
            session.outcome !== "succeeded" || session.directory !== config.directory) {
          throw new Error("Follow-up resolved a different session identity or outcome");
        }
        store.completeReview(jobId, attemptId, sessionId, launched.summary, {
          runtimeVersion: "2.0.16", agent: session.agent, model: expectedModel,
        });
      })().catch(() => {
        if (claimed) store.failReview(jobId, attemptId);
        else store.failQueuedFollowup(jobId, attemptId);
      }).finally(() => localClients.delete(jobId));
      activeReviews.add(work);
      try { await work; } finally { activeReviews.delete(work); }
    });
  };
  const scheduleCodeCancellation: ScheduleCodeCancellation = (jobId, config, worktreePath, sessionId) => {
    if (cancellations.has(jobId)) return;
    cancellations.add(jobId);
    if (store.codeApplying(jobId)) {
      localClients.get(jobId)?.abort();
      store.cancelUncertain(jobId);
      cancellations.delete(jobId);
      return;
    }
    const work = interruptCode(config, worktreePath, sessionId)
      .then(confirmed => { if (confirmed) { store.confirmCancelled(jobId, sessionId); scheduler.releaseHeld(jobId); } else store.cancelUncertain(jobId); })
      .catch(() => store.cancelUncertain(jobId))
      .finally(() => localClients.get(jobId)?.abort());
    activeReviews.add(work);
    void work.finally(() => { cancellations.delete(jobId); activeReviews.delete(work); });
  };
  const scheduleCode: ScheduleCode = (jobId, input, config, worktreePath) => {
    scheduler.submit("write", jobId, async () => {
      let attemptId: string | undefined;
      const work = (async () => {
        await preflightProposal(config, worktreePath);
        const before = await snapshotFingerprint(worktreePath, input.baseSha);
        attemptId = store.claimReview(jobId);
        const localClient = new AbortController();
        localClients.set(jobId, localClient);
        const launched = await runProposal(config, worktreePath, input.task, event => {
          store.recordReviewEvent(jobId, attemptId!, event);
          if (event.sessionID && store.cancellationNeeded(jobId)) scheduleCodeCancellation(jobId, config, worktreePath, event.sessionID);
        }, localClient.signal, store.runtimeTimeoutMs(jobId));
        const session = await getCodeSession(config, worktreePath, launched.sessionId);
        if (session.outcome !== "succeeded" || session.agent !== config.agent || `${session.model.providerID}/${session.model.id}` !== config.model || session.directory !== worktreePath) throw new Error("Proposal session identity or outcome differed");
        if (before !== await snapshotFingerprint(worktreePath, input.baseSha)) throw new Error("Read-only proposal changed the worktree");
        const patch = validatePatch(launched.proposal, worktreePath, input.baseSha);
        store.completeProposal(jobId, attemptId, launched.sessionId, launched.proposal, before, patch);
      })().catch(() => {
        if (attemptId) store.failReview(jobId, attemptId);
        else store.failCodePreflight(jobId);
      }).finally(() => localClients.delete(jobId));
      activeReviews.add(work);
      try { await work; } finally { activeReviews.delete(work); }
    });
  };
  const scheduleApply: ScheduleApply = (jobId, input, config, worktreePath, proposal, sessionId) => {
    scheduler.submit("write", jobId, async () => {
      let attemptId: string | undefined;
      const localClient = new AbortController();
      const work = (async () => {
        attemptId = store.claimCodeApply(jobId, sessionId);
        localClients.set(jobId, localClient);
        if (await snapshotFingerprint(worktreePath, input.baseSha) !== store.codeProposalFingerprint(jobId)) throw new Error("Owned worktree changed after proposal approval");
        const patch = validatePatch(proposal, worktreePath, input.baseSha);
        const applied = applyValidatedPatch(patch);
        if (applied.path !== patch.path || applied.sha256 !== patch.afterSha256) throw new Error("Applied patch differs from approval");
        const snapshot = await verifySnapshot({ worktreePath, baseSha: input.baseSha, commands: input.verificationCommands,
          artifactDirectory: join(directory, "artifacts", jobId), signal: localClient.signal });
        if (localClient.signal.aborted) throw new Error("Verification was cancelled");
        store.completeCode(jobId, attemptId, sessionId, `Validated patch applied to ${applied.path}`,
          { runtimeVersion: "2.0.18", agent: config.agent, model: config.model }, snapshot);
      })().catch(() => {
        if (attemptId) store.failCodeVerification(jobId, attemptId, "Patch apply or verification did not finish with retained evidence.");
        else store.failCodePreflight(jobId);
      }).finally(() => localClients.delete(jobId));
      activeReviews.add(work);
      try { await work; } finally { activeReviews.delete(work); }
    });
  };
  const server: Server = createServer(socket => handleConnection(socket, store, worktrees, directory, scheduleReview, scheduleFollowup, scheduleCancellation, scheduleCode, scheduleCodeCancellation, scheduleApply));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.off("error", reject); resolve(); });
    });
    chmodSync(socketPath, 0o600);
  } catch (error) {
    store.close();
    worktrees.close();
    throw error;
  }
  const socketStat = lstatSync(socketPath);
  for (const queued of store.pendingReviews()) {
    try {
      const config = parseRoleConfig({ schemaVersion: 1, roles: { reviewer: queued.config } }).roles.reviewer;
      scheduleReview(queued.jobId, queued.task, config);
    } catch { store.failReview(queued.jobId); }
  }
  for (const queued of store.pendingFollowups()) {
    try {
      const config = enforceReviewerPolicy(parseRoleConfig({ schemaVersion: 1, roles: { reviewer: queued.config } }).roles.reviewer);
      scheduleFollowup(queued.jobId, queued.attemptId, queued.task, config, queued.sessionId);
    } catch { store.failQueuedFollowup(queued.jobId, queued.attemptId); }
  }
  for (const queued of store.pendingCodes()) scheduleCode(queued.jobId, queued.input, { ...queued.config, runtime: "opencode" }, queued.worktreePath);
  for (const queued of store.pendingApplies()) scheduleApply(queued.jobId, queued.input, queued.config, queued.worktreePath, queued.proposal, queued.sessionId);
  for (const candidate of store.reconciliationCandidates()) {
    try {
      const config = parseRoleConfig({ schemaVersion: 1, roles: { reviewer: candidate.config } }).roles.reviewer;
      const work = (async () => {
        const session = await getReviewSession(config, candidate.sessionId);
        const expectedModel = `${session.model.providerID}/${session.model.id}`;
        if (session.agent !== config.agent || expectedModel !== config.model) return;
        if (await isReviewSessionActive(config, candidate.sessionId)) return;
        if (session.directory === config.directory && (session.outcome === "succeeded" || session.outcome === "failed" || session.outcome === "interrupted")) {
          store.reconcileTerminal(candidate.jobId, candidate.sessionId, session.outcome, candidate.cancelRequested);
          if (!["interrupted", "cancelling"].includes(store.status(candidate.jobId).state)) scheduler.releaseHeld(candidate.jobId);
        }
      })().catch(() => { /* Keep uncertain jobs and scope locks when lookup fails. */ });
      activeReviews.add(work);
      void work.finally(() => activeReviews.delete(work));
    } catch { /* Invalid saved config remains interrupted for manual inspection. */ }
  }
  return {
    socketPath,
    close: async () => {
      scheduler.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await Promise.allSettled([...activeReviews]);
      store.close();
      worktrees.close();
      try {
        const current = lstatSync(socketPath);
        if (current.ino === socketStat.ino && current.dev === socketStat.dev) unlinkSync(socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}
