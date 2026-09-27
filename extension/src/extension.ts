import * as vscode from "vscode";
import { GattiniClient, ClientError, type Approval, type PublicEvent } from "./client.js";
import { JobSession } from "./session.js";
import { evidenceLines, resultLines, safeLine } from "./views.js";

let timer: NodeJS.Timeout | undefined;
let active = false;

function clean(value: unknown): string {
  return safeLine(value, 2000);
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Gattini Jobs");
  context.subscriptions.push(output);
  const client = new GattiniClient();
  const session = new JobSession(client, context.workspaceState);
  const polling = new Set<string>();
  const lastStatus = new Map<string, string>();

  const refresh = async (): Promise<void> => {
    if (active) return;
    active = true;
    try {
      for (const job of session.jobs()) {
        if (polling.has(job.jobId)) continue;
        polling.add(job.jobId);
        try {
          const { status } = await session.refresh(job.jobId, (event: PublicEvent) => {
            output.appendLine(`${clean(event.jobId)} #${event.sequence} ${clean(event.at ?? "")} ${clean(event.type)} ${clean(JSON.stringify(event.detail))}`);
          });
          const marker = `${status.state}\0${status.updatedAt}`;
          if (lastStatus.get(status.jobId) !== marker) {
            output.appendLine(`${clean(status.jobId)}: ${clean(status.state)} (${clean(status.updatedAt)})`);
            lastStatus.set(status.jobId, marker);
          }
        } catch (error) {
          const code = error instanceof ClientError ? error.code : "CLIENT_ERROR";
          output.appendLine(`${clean(job.jobId)}: ${clean(code)} — ${clean(error instanceof Error ? error.message : "Unknown error")}`);
        } finally { polling.delete(job.jobId); }
      }
    } finally { active = false; }
  };

  const showFailure = async (error: unknown): Promise<void> => {
    const failure = error instanceof ClientError ? error : new ClientError("CLIENT_ERROR", "Gattini request failed");
    await vscode.window.showErrorMessage(`Gattini ${clean(failure.code)}: ${clean(failure.message)}`);
  };
  const trustedAction = async (): Promise<boolean> => {
    if (vscode.workspace.isTrusted) return true;
    await vscode.window.showErrorMessage("Trust this workspace before changing a Gattini job or approval.");
    return false;
  };
  const chooseJob = async (): Promise<string | undefined> => {
    const jobs = session.jobs();
    if (!jobs.length) { await vscode.window.showInformationMessage("No Gattini jobs are saved in this workspace."); return undefined; }
    const picked = await vscode.window.showQuickPick(jobs.map(job => ({ label: job.jobId, description: job.workspace, jobId: job.jobId })),
      { placeHolder: "Select the exact Gattini job" });
    return picked?.jobId;
  };
  const chooseFolder = async (): Promise<vscode.WorkspaceFolder | undefined> => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) { await vscode.window.showErrorMessage("Open a workspace folder to use Gattini."); return undefined; }
    const picked = folders.length === 1 ? { folder: folders[0] } : await vscode.window.showQuickPick(
      folders.map(item => ({ label: item.name, description: item.uri.fsPath, folder: item })),
      { placeHolder: "Select the workspace folder for this job" }
    );
    return picked?.folder;
  };

  context.subscriptions.push(vscode.commands.registerCommand("gattini.submitTask", async () => {
    if (!vscode.workspace.isTrusted) { await vscode.window.showErrorMessage("Trust this workspace before submitting a Gattini task."); return; }
    const folder = await chooseFolder();
    if (!folder) return;
    const task = await vscode.window.showInputBox({ prompt: `Gattini task for ${folder.name}`, ignoreFocusOut: true });
    if (task === undefined) return;
    if (!vscode.workspace.isTrusted) { await vscode.window.showErrorMessage("Workspace trust changed; task was not submitted."); return; }
    try {
      const job = await session.submit(folder.uri.toString(), task, () => vscode.workspace.isTrusted);
      output.appendLine(`${clean(job.jobId)} submitted from ${clean(folder.uri.fsPath)}`);
      output.show(true);
      await refresh();
    } catch (error) {
      await showFailure(error);
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("gattini.attachJob", async () => {
    if (!vscode.workspace.isTrusted) { await vscode.window.showErrorMessage("Trust this workspace before attaching a Gattini job."); return; }
    const folder = await chooseFolder();
    if (!folder) return;
    const jobId = await vscode.window.showInputBox({ prompt: "Enter the exact existing Gattini job ID", ignoreFocusOut: true });
    if (jobId === undefined) return;
    if (!vscode.workspace.isTrusted) { await vscode.window.showErrorMessage("Workspace trust changed; job was not attached."); return; }
    try {
      const job = await session.attach(folder.uri.toString(), jobId, () => vscode.workspace.isTrusted);
      output.appendLine(`${clean(job.jobId)} attached to ${clean(folder.uri.fsPath)}`);
      output.show(true);
      await refresh();
    } catch (error) { await showFailure(error); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("gattini.showJobs", async () => {
    output.show(true);
    await refresh();
  }));
  context.subscriptions.push(vscode.commands.registerCommand("gattini.showResult", async () => {
    const jobId = await chooseJob();
    if (!jobId) return;
    try {
      const value = await client.result(jobId);
      for (const line of resultLines(value)) output.appendLine(line);
      output.show(true);
    } catch (error) { await showFailure(error); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("gattini.showEvidence", async () => {
    const jobId = await chooseJob();
    if (!jobId) return;
    const picked = await vscode.window.showQuickPick([{ label: "Diff", kind: "diff" as const }, { label: "Snapshot metadata", kind: "snapshot" as const }],
      { placeHolder: "Select verified evidence kind" });
    if (!picked) return;
    try {
      const result = await client.result(jobId);
      if (!result.result) { await vscode.window.showInformationMessage("This job has no completed result yet."); return; }
      const evidence = await client.evidence(jobId, result.attemptId, picked.kind);
      for (const line of evidenceLines(evidence)) output.appendLine(line);
      output.show(true);
    } catch (error) { await showFailure(error); }
  }));
  const decide = async (decision: "approve" | "deny"): Promise<void> => {
    if (!await trustedAction()) return;
    try {
      const list = await client.approvals();
      if (!list.length) { await vscode.window.showInformationMessage("No pending Gattini approvals."); return; }
      const picked = await vscode.window.showQuickPick(list.map(row => ({
        label: row.id, description: `Job ${row.jobId}; ${row.actionKind}`, detail: `Expires ${row.expiresAt}`, approval: row
      })), { placeHolder: "Select the exact pending approval" });
      if (!picked) return;
      const selected: Approval = picked.approval;
      const latest = (await client.approvals()).find(row => row.id === selected.id);
      const status = await client.status(selected.jobId);
      if (!latest || latest.jobId !== selected.jobId || latest.actionKind !== selected.actionKind ||
          latest.createdAt !== selected.createdAt || latest.expiresAt !== selected.expiresAt ||
          status.state !== "awaiting-approval" || !Number.isFinite(Date.parse(latest.expiresAt)) || Date.parse(latest.expiresAt) <= Date.now()) {
        throw new ClientError("APPROVAL_STALE", "Approval changed or expired; refresh the pending list");
      }
      const verb = decision === "approve" ? "Approve" : "Deny";
      const confirmation = await vscode.window.showWarningMessage(
        `${verb} approval ${clean(selected.id)} for job ${clean(selected.jobId)} (${clean(selected.actionKind)})?`,
        { modal: true }, verb);
      if (confirmation !== verb) return;
      if (!await trustedAction()) return;
      const response = await client.decide(selected.id, decision);
      if (response.jobId !== selected.jobId) throw new ClientError("PROTOCOL_ERROR", "Decision changed job identity");
      const refreshed = await client.status(selected.jobId);
      output.appendLine(`Approval ${clean(selected.id)} for job ${clean(selected.jobId)}: ${clean(response.state)}; job ${clean(refreshed.state)}`);
      output.show(true);
    } catch (error) { await showFailure(error); }
  };
  context.subscriptions.push(vscode.commands.registerCommand("gattini.approve", () => decide("approve")));
  context.subscriptions.push(vscode.commands.registerCommand("gattini.deny", () => decide("deny")));
  context.subscriptions.push(vscode.commands.registerCommand("gattini.cancel", async () => {
    if (!await trustedAction()) return;
    const jobId = await chooseJob();
    if (!jobId) return;
    try {
      const current = await client.status(jobId);
      if (["completed", "failed", "cancelled"].includes(current.state)) {
        await vscode.window.showInformationMessage(`Job ${clean(jobId)} is already ${clean(current.state)}.`);
        return;
      }
      const confirmation = await vscode.window.showWarningMessage(`Request cancellation for exact job ${clean(jobId)}?`, { modal: true }, "Cancel job");
      if (confirmation !== "Cancel job") return;
      if (!await trustedAction()) return;
      await client.cancel(jobId);
      const refreshed = await client.status(jobId);
      output.appendLine(`Job ${clean(jobId)} cancellation requested; durable state: ${clean(refreshed.state)}`);
      output.show(true);
    } catch (error) { await showFailure(error); }
  }));
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { void refresh(); }));
  timer = setInterval(() => { void refresh(); }, 3000);
  context.subscriptions.push({ dispose: () => { if (timer) clearInterval(timer); timer = undefined; } });
  void refresh();
}

export function deactivate(): void { if (timer) clearInterval(timer); timer = undefined; }
