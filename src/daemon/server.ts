import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { JobStore } from "./store.js";
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION, ProtocolError, parseRequest, stringParam, type Request, type Response } from "../core/protocol.js";
import { parseRoleConfig } from "../core/role-config.js";
import { getReviewSession, interruptReview, isReviewSessionActive, preflightReview, runReview, type ReviewRole } from "../adapters/opencode-cli.js";

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
type ScheduleCancellation = (jobId: string, config: ReviewRole, sessionId: string) => void;

function dispatch(store: JobStore, request: Request, directory: string, scheduleReview: ScheduleReview, scheduleCancellation: ScheduleCancellation): unknown {
  const params = request.params;
  if (request.method === "start") {
    exactParams(params, ["task", "idempotencyKey", "role"]);
    const task = stringParam(params, "task", 16_384);
    const idempotencyKey = stringParam(params, "idempotencyKey", 128);
    const role = stringParam(params, "role", 128);
    if (role === "reviewer") {
      let config: ReviewRole;
      try { config = parseRoleConfig(JSON.parse(readFileSync(join(directory, "roles.json"), "utf8"))).roles.reviewer; }
      catch { throw new ProtocolError("CONFIG_INVALID", "A valid private roles.json is required for reviewer jobs"); }
      const enqueued = store.enqueueReview({ task, idempotencyKey, role, config });
      if (!enqueued.deduplicated) scheduleReview(enqueued.jobId, task, config);
      return enqueued;
    }
    if (role !== "code") throw new ProtocolError("INVALID_REQUEST", "Only code (fake) and reviewer (OpenCode) roles are supported");
    return store.start({ task, idempotencyKey, role });
  }
  exactParams(params, ["jobId"]);
  const jobId = stringParam(params, "jobId", 128);
  if (request.method === "status") return store.status(jobId);
  if (request.method === "cancel") {
    const cancellation = store.requestCancel(jobId);
    if (cancellation.state === "cancelling" && cancellation.runtimeSessionId && cancellation.config) {
      const config = parseRoleConfig({ schemaVersion: 1, roles: { reviewer: cancellation.config } }).roles.reviewer;
      scheduleCancellation(jobId, config, cancellation.runtimeSessionId);
    }
    return { jobId, state: cancellation.state };
  }
  return store.result(jobId);
}

function handleConnection(socket: Socket, store: JobStore, directory: string, scheduleReview: ScheduleReview, scheduleCancellation: ScheduleCancellation): void {
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
      const result = dispatch(store, request, directory, scheduleReview, scheduleCancellation);
      reply({ protocolVersion: PROTOCOL_VERSION, requestId, ok: true, result });
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
  const activeReviews = new Set<Promise<void>>();
  const cancellations = new Set<string>();
  const localClients = new Map<string, AbortController>();
  const scheduleCancellation: ScheduleCancellation = (jobId, config, sessionId) => {
    if (cancellations.has(jobId)) return;
    cancellations.add(jobId);
    const work = interruptReview(config, sessionId)
      .then(confirmed => { if (confirmed) store.confirmCancelled(jobId, sessionId); else store.cancelUncertain(jobId); })
      .catch(() => store.cancelUncertain(jobId))
      .finally(() => localClients.get(jobId)?.abort());
    activeReviews.add(work);
    void work.finally(() => { cancellations.delete(jobId); activeReviews.delete(work); });
  };
  const scheduleReview: ScheduleReview = (jobId, task, config) => {
    queueMicrotask(() => {
      let attemptId: string | undefined;
      const work = (async () => {
        await preflightReview(config);
        attemptId = store.claimReview(jobId);
        const localClient = new AbortController();
        localClients.set(jobId, localClient);
        const launched = await runReview(config, task, event => {
          store.recordReviewEvent(jobId, attemptId!, event);
          if (event.sessionID && store.cancellationNeeded(jobId)) scheduleCancellation(jobId, config, event.sessionID);
        }, localClient.signal);
        const session = await getReviewSession(config, launched.sessionId);
        const expectedModel = `${session.model.providerID}/${session.model.id}`;
        if (session.agent !== config.agent || expectedModel !== config.model || session.outcome !== "succeeded" || session.directory !== config.directory) {
          throw new Error("OpenCode session resolved identity or outcome differs from request");
        }
        store.completeReview(jobId, attemptId, launched.sessionId, launched.summary, {
          runtimeVersion: "2.0.16", agent: session.agent, model: expectedModel,
        });
      })().catch(() => { store.failReview(jobId, attemptId); }).finally(() => localClients.delete(jobId));
      activeReviews.add(work);
      void work.finally(() => activeReviews.delete(work));
    });
  };
  const server: Server = createServer(socket => handleConnection(socket, store, directory, scheduleReview, scheduleCancellation));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.off("error", reject); resolve(); });
    });
    chmodSync(socketPath, 0o600);
  } catch (error) {
    store.close();
    throw error;
  }
  const socketStat = lstatSync(socketPath);
  for (const queued of store.pendingReviews()) {
    try {
      const config = parseRoleConfig({ schemaVersion: 1, roles: { reviewer: queued.config } }).roles.reviewer;
      scheduleReview(queued.jobId, queued.task, config);
    } catch { store.failReview(queued.jobId); }
  }
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
        }
      })().catch(() => { /* Keep uncertain jobs and scope locks when lookup fails. */ });
      activeReviews.add(work);
      void work.finally(() => activeReviews.delete(work));
    } catch { /* Invalid saved config remains interrupted for manual inspection. */ }
  }
  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await Promise.allSettled([...activeReviews]);
      store.close();
      try {
        const current = lstatSync(socketPath);
        if (current.ino === socketStat.ino && current.dev === socketStat.dev) unlinkSync(socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}
