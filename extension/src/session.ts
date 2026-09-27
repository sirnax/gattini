import { createHash, randomUUID } from "node:crypto";
import { ClientError, type EventPage, type GattiniClient, type JobStatus, type PublicEvent } from "./client.js";

export type SavedJob = { workspace: string; jobId: string; cursor: number };
type Pending = { workspace: string; digest: string; idempotencyKey: string };
export interface StateStore { get<T>(key: string, defaultValue: T): T; update(key: string, value: unknown): PromiseLike<void> }
const JOBS_KEY = "gattini.v2.jobs";
const PENDING_KEY = "gattini.v2.pending";

function validJob(value: unknown): value is SavedJob {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.workspace === "string" && row.workspace.length > 0 && typeof row.jobId === "string" && row.jobId.length > 0 &&
    Number.isSafeInteger(row.cursor) && (row.cursor as number) >= 0;
}
function validPending(value: unknown): value is Pending {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.workspace === "string" && typeof row.digest === "string" && typeof row.idempotencyKey === "string";
}

export class JobSession {
  constructor(private readonly client: Pick<GattiniClient, "start" | "status" | "events">, private readonly storage: StateStore) {}

  jobs(): SavedJob[] {
    const raw = this.storage.get<unknown>(JOBS_KEY, []);
    return Array.isArray(raw) ? raw.filter(validJob) : [];
  }

  async submit(workspace: string, task: string, trusted: () => boolean): Promise<SavedJob> {
    if (!trusted()) throw new ClientError("WORKSPACE_UNTRUSTED", "Trust this workspace before submitting a Gattini task");
    const digest = createHash("sha256").update(workspace).update("\0").update(task).digest("hex");
    const raw = this.storage.get<unknown>(PENDING_KEY, []);
    const pending = Array.isArray(raw) ? raw.filter(validPending) : [];
    let entry = pending.find(row => row.workspace === workspace && row.digest === digest);
    if (!entry) {
      entry = { workspace, digest, idempotencyKey: randomUUID() };
      await this.storage.update(PENDING_KEY, [...pending, entry]);
    }
    if (!trusted()) throw new ClientError("WORKSPACE_UNTRUSTED", "Trust this workspace before submitting a Gattini task");
    const result = await this.client.start(task, entry.idempotencyKey);
    const current = this.jobs();
    const job = current.find(row => row.jobId === result.jobId) ?? { workspace, jobId: result.jobId, cursor: 0 };
    if (!current.some(row => row.jobId === result.jobId)) await this.storage.update(JOBS_KEY, [...current, job]);
    await this.storage.update(PENDING_KEY, pending.filter(row => row !== entry));
    return job;
  }

  async attach(workspace: string, jobId: string, trusted: () => boolean): Promise<SavedJob> {
    if (!trusted()) throw new ClientError("WORKSPACE_UNTRUSTED", "Trust this workspace before attaching a Gattini job");
    const status = await this.client.status(jobId); // hello and exact daemon ID validation
    if (!trusted()) throw new ClientError("WORKSPACE_UNTRUSTED", "Workspace trust changed; job was not attached");
    const current = this.jobs();
    const prior = current.find(row => row.jobId === status.jobId);
    const job = prior ? { ...prior, workspace } : { workspace, jobId: status.jobId, cursor: 0 };
    await this.storage.update(JOBS_KEY, prior
      ? current.map(row => row.jobId === status.jobId ? job : row)
      : [...current, job]);
    return job;
  }

  async refresh(jobId: string, onEvent: (event: PublicEvent) => void): Promise<{ status: JobStatus; pageCount: number }> {
    const job = this.jobs().find(row => row.jobId === jobId);
    if (!job) throw new ClientError("UNKNOWN_LOCAL_JOB", "Job is not saved in this workspace");
    const status = await this.client.status(jobId);
    let pageCount = 0;
    for (let i = 0; i < 100; i += 1) {
      const page: EventPage = await this.client.events(jobId, job.cursor, 100);
      pageCount += 1;
      for (const event of page.events) {
        onEvent(event);
        job.cursor = event.sequence;
        const jobs = this.jobs().map(row => row.jobId === jobId ? { ...row, cursor: job.cursor } : row);
        await this.storage.update(JOBS_KEY, jobs);
      }
      if (!page.hasMore) return { status, pageCount };
    }
    throw new ClientError("EVENT_BACKLOG", "Event backlog exceeds one refresh cycle");
  }
}
