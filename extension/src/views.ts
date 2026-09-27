import type { Evidence, JobResult } from "./client.js";

export function safeLine(value: unknown, max = 4096): string {
  return String(value).slice(0, max).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

export function resultLines(view: JobResult): string[] {
  const lines = [`Job ${safeLine(view.jobId)}: ${safeLine(view.state)}`];
  if (view.attemptId) lines.push(`Attempt: ${safeLine(view.attemptId)}`);
  if (!view.result) return [...lines, "Result is not available yet."];
  const result = view.result;
  lines.push(`Execution: ${safeLine(result.execution)}`, `Acceptance: ${safeLine(result.acceptance)}`, `Summary: ${safeLine(result.summary)}`);
  for (const file of result.changedFiles) lines.push(`Changed file: ${safeLine(file)}`);
  for (const check of result.verification) lines.push(`Check: ${safeLine(check.command)} (exit ${check.exitCode === null ? "unknown" : check.exitCode})`);
  for (const limit of result.limitations) lines.push(`Limitation: ${safeLine(limit)}`);
  return lines;
}

export function evidenceLines(view: Evidence): string[] {
  const lines = [`Evidence for job ${safeLine(view.jobId)}${view.attemptId ? `, attempt ${safeLine(view.attemptId)}` : ""}`,
    `Kind: ${view.kind}; SHA-256: ${view.sha256}; truncated: ${view.truncated}`];
  if (view.text) lines.push(...view.text.split(/\r?\n/).slice(0, 2048).map(line => safeLine(line)));
  else lines.push("No content projection is available for this evidence kind.");
  return lines;
}
