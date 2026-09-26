/** In-process admission for durable jobs. The store remains the source of job state. */
export type WorkerClass = "read" | "write";

type Work = () => Promise<void>;

export class WorkerScheduler {
  private readonly queued: Array<{ jobId: string; workerClass: WorkerClass; work: Work }> = [];
  private readonly active = new Map<string, WorkerClass>();
  private readonly held = new Map<string, WorkerClass>();
  private closed = false;

  constructor(private readonly shouldHold: (jobId: string) => boolean,
    private readonly onError: (jobId: string, error: unknown) => void,
    initialHeld: Array<{ jobId: string; workerClass: WorkerClass }> = []) {
    for (const item of initialHeld) this.held.set(item.jobId, item.workerClass);
  }

  submit(workerClass: WorkerClass, jobId: string, work: Work): void {
    if (this.closed || this.active.has(jobId) || this.held.has(jobId) || this.queued.some(item => item.jobId === jobId)) return;
    this.queued.push({ workerClass, jobId, work });
    this.drain();
  }

  releaseHeld(jobId: string): void {
    if (this.held.delete(jobId)) this.drain();
  }

  snapshot(): { queued: string[]; activeRead: number; activeWrite: number; heldRead: number; heldWrite: number } {
    return { queued: this.queued.map(item => item.jobId),
      activeRead: [...this.active.values()].filter(value => value === "read").length,
      activeWrite: [...this.active.values()].filter(value => value === "write").length,
      heldRead: [...this.held.values()].filter(value => value === "read").length,
      heldWrite: [...this.held.values()].filter(value => value === "write").length };
  }

  close(): void { this.closed = true; this.queued.length = 0; }

  private drain(): void {
    if (this.closed) return;
    for (let index = 0; index < this.queued.length;) {
      const item = this.queued[index]!;
      const occupied = [...this.active.values(), ...this.held.values()].filter(kind => kind === item.workerClass).length;
      if (occupied >= 1) { index += 1; continue; }
      this.queued.splice(index, 1);
      this.active.set(item.jobId, item.workerClass);
      queueMicrotask(() => {
        void item.work().catch(error => this.onError(item.jobId, error)).finally(() => {
          this.active.delete(item.jobId);
          try { if (this.shouldHold(item.jobId)) this.held.set(item.jobId, item.workerClass); }
          catch { this.held.set(item.jobId, item.workerClass); }
          this.drain();
        });
      });
    }
  }
}
