/** Usage observed from one exact OpenCode session. Values are runtime reported. */
export interface UsageProvenance {
  runtime: "opencode" | "codex";
  sessionId: string;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

type Measure = "costUsd" | "inputTokens" | "outputTokens";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function observedMeasure(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function usageValues(event: Record<string, unknown>): Record<Measure, number | null> {
  const part = record(event.part);
  const tokens = record(part?.tokens);
  return {
    costUsd: observedMeasure(part?.cost),
    inputTokens: observedMeasure(tokens?.input),
    outputTokens: observedMeasure(tokens?.output),
  };
}

function eventIdentity(event: Record<string, unknown>): string | null {
  for (const value of [event.id, event.eventID, event.eventId]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  const part = record(event.part);
  return typeof part?.id === "string" && part.id.length > 0 ? part.id : null;
}

/**
 * Accumulates only step_finish events from one explicitly selected OpenCode
 * session. If any accepted step omits or reports an invalid measure, that
 * measure's session total stays null because a complete total is unknown.
 */
export class OpenCodeUsageAccumulator {
  readonly runtime = "opencode" as const;
  readonly sessionId: string;
  private readonly seenIdentities = new Set<string>();
  private readonly totals: Record<Measure, number> = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
  private readonly complete: Record<Measure, boolean> = { costUsd: true, inputTokens: true, outputTokens: true };
  private acceptedSteps = 0;

  constructor(sessionId: string) {
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("OpenCode usage requires an exact session ID");
    this.sessionId = sessionId;
  }

  /** Returns true only when this event contributed a new step to the session. */
  add(eventValue: unknown): boolean {
    const event = record(eventValue);
    if (!event || event.type !== "step_finish" || event.sessionID !== this.sessionId) return false;

    const identity = eventIdentity(event);
    if (identity !== null) {
      const key = `${this.sessionId}\0${identity}`;
      if (this.seenIdentities.has(key)) return false;
      this.seenIdentities.add(key);
    }

    const values = usageValues(event);
    this.acceptedSteps += 1;
    for (const measure of ["costUsd", "inputTokens", "outputTokens"] as const) {
      const value = values[measure];
      if (value === null) this.complete[measure] = false;
      else this.totals[measure] += value;
    }
    return true;
  }

  snapshot(): UsageProvenance {
    const total = (measure: Measure): number | null =>
      this.acceptedSteps > 0 && this.complete[measure] ? this.totals[measure] : null;
    return {
      runtime: this.runtime,
      sessionId: this.sessionId,
      costUsd: total("costUsd"),
      inputTokens: total("inputTokens"),
      outputTokens: total("outputTokens"),
    };
  }
}
