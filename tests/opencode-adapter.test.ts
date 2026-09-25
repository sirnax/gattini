import assert from "node:assert/strict";
import test from "node:test";
import { OpenCodeApiError, OpenCodeV2Client } from "../src/adapters/opencode.js";

const baseUrl = "http://127.0.0.1:4096";
const directory = "/tmp/gattini disposable repo";
const sessionId = "ses_test-1";
const model = { providerID: "provider", modelID: "model" };
const permissions = [{ action: "*", resource: "*", effect: "ask" as const }];

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/json" } });
}

function client(fetcher: typeof fetch): OpenCodeV2Client {
  return new OpenCodeV2Client({ baseUrl, directory, fetch: fetcher });
}

function session(overrides: Record<string, unknown> = {}) {
  return { id: sessionId, agent: "reviewer", model: { providerID: model.providerID, modelID: model.modelID }, ...overrides };
}

test("rejects non-loopback URLs before making a request", () => {
  let called = false;
  assert.throws(() => new OpenCodeV2Client({
    baseUrl: "http://192.168.1.10:4096", directory, fetch: async () => { called = true; return response([]); },
  }), OpenCodeApiError);
  assert.equal(called, false);
});

test("queries agents by project location and tolerates a temporary empty list on session creation", async () => {
  const urls: URL[] = [];
  let agentCalls = 0;
  const api = client(async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.pathname === "/api/agent") {
      agentCalls += 1;
      return response(agentCalls === 1 ? [] : [{ id: "reviewer" }]);
    }
    if (url.pathname === "/api/model") return response([model]);
    if (url.pathname === "/api/session") return response(session());
    throw new Error(`Unexpected request ${url}`);
  });

  const created = await api.createSession({ agent: "reviewer", model, permissions });
  assert.equal(created.id, sessionId);
  assert.equal(agentCalls, 2);
  assert.equal(urls.filter((url) => url.pathname === "/api/agent").every((url) => url.searchParams.get("location[directory]") === directory), true);
});

test("rejects unavailable requested model before creating a session", async () => {
  const api = client(async (input) => new URL(String(input)).pathname === "/api/agent"
    ? response([{ id: "reviewer" }])
    : response([]));
  await assert.rejects(api.createSession({ agent: "reviewer", model, permissions }), /model is unavailable/);
});

test("rejects a created session whose agent or model differs from the request", async () => {
  for (const data of [session({ agent: "writer" }), session({ model: { providerID: "provider", modelID: "other" } })]) {
    const api = client(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/agent") return response([{ id: "reviewer" }]);
      if (path === "/api/model") return response([model]);
      return response(data);
    });
    await assert.rejects(api.createSession({ agent: "reviewer", model, permissions }), /identity different/);
  }
});

test("rejects session lookup and prompt admission when OpenCode returns a different session ID", async () => {
  const api = client(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/prompt")) return response({ sessionID: "ses_other" });
    return response(session({ id: "ses_other" }));
  });
  await assert.rejects(api.getSession(sessionId), /different session ID/);
  await assert.rejects(api.sendPrompt(sessionId, "Review this repository"), /different session/);
});

test("reports active status from the exact session key", async () => {
  const api = client(async () => response({ [sessionId]: { status: "busy" } }));
  assert.equal(await api.isSessionActive(sessionId), true);
  const inactive = client(async () => response({ ses_another: {} }));
  assert.equal(await inactive.isSessionActive(sessionId), false);
});

test("accepts an explicit negative interrupt result and rejects malformed results", async () => {
  const inactive = client(async () => response({ interrupted: false }));
  assert.deepEqual(await inactive.interrupt(sessionId), { sessionId, interrupted: false });
  const malformed = client(async () => response({ interrupted: "no" }));
  await assert.rejects(malformed.interrupt(sessionId), /missing boolean interrupted/);
});

test("bounds historical log records and forwards the cursor", async () => {
  let requested: URL | undefined;
  const api = client(async (input) => {
    requested = new URL(String(input));
    return new Response("id: 1\ndata: first\n\nid: 2\ndata: second\n", { status: 200 });
  });
  assert.deepEqual(await api.readLog(sessionId, { after: "cursor-1", maxRecords: 1 }), ["id: 1\ndata: first"]);
  assert.equal(requested?.searchParams.get("after"), "cursor-1");
  assert.equal(requested?.searchParams.get("follow"), "false");
});

test("projects message errors for caller inspection", async () => {
  const runtimeError = { name: "ProviderError", message: "temporarily unavailable" };
  const api = client(async () => response([{ id: "msg-1", type: "assistant", error: runtimeError, text: "request failed" }]));
  assert.deepEqual(await api.listMessages(sessionId), [{ id: "msg-1", type: "assistant", error: runtimeError, text: "request failed" }]);
});
