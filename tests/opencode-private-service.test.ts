import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { getReviewSession, interruptReview, preflightReview, runReview, type ReviewRole } from "../src/adapters/opencode-cli.js";
import { getCodeSession, preflightProposal, runProposal } from "../src/adapters/opencode-code.js";
import { parseCodeRoleConfig } from "../src/core/code-policy.js";

const URL = "http://127.0.0.1:49193";
const RULES = [
  { action: "*", resource: "*", effect: "deny" as const },
  { action: "read", resource: "*", effect: "allow" as const },
  { action: "glob", resource: "*", effect: "allow" as const },
  { action: "grep", resource: "*", effect: "allow" as const },
];

function fixture(mode = "good") {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "gattini-private-opencode-")));
  const bin = join(directory, "bin");
  const calls = join(directory, "calls.jsonl");
  mkdirSync(bin);
  const executable = join(bin, "opencode");
  writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(args) + "\\n");
const mode = process.env.FAKE_MODE;
const operation = args.find(value => ["session.active", "agent.list", "session.get", "session.interrupt"].includes(value));
if (args[0] === "--version") console.log("opencode v2.0.18");
else if (args[0] === "service") throw Error("shared service must not be queried");
else if (args[0] === "api" && args.includes("/api/info")) console.log(JSON.stringify({data:{version:mode === "version" ? "2.0.11" : "2.0.18"}}));
else if (operation === "session.active") console.log(JSON.stringify({data:{}}));
else if (operation === "agent.list") {
  const calls = fs.readFileSync(process.env.FAKE_CALLS, "utf8").split("\\n").filter(line => line.includes("agent.list")).length;
  console.log(JSON.stringify({data:mode === "lag" && calls === 1 ? [] : [{id:process.env.FAKE_AGENT,permissions:mode === "policy" ? [{action:"*",resource:"*",effect:"allow"}] : ${JSON.stringify(RULES)}}]}));
}
else if (operation === "session.get") console.log(JSON.stringify({data:{id:"ses_private123",agent:mode === "identity" ? "wrong" : process.env.FAKE_AGENT,model:{providerID:"provider",id:"model"},outcome:"interrupted",location:{directory:process.cwd()}}}));
else if (operation === "session.interrupt") console.log(JSON.stringify({interrupted:true}));
else if (args[0] === "models") console.log("provider/model");
else if (args[0] === "run") {console.log(JSON.stringify({type:"step_start",sessionID:"ses_private123"}));console.log(JSON.stringify({type:"text",sessionID:"ses_private123",part:{text:"Done"}}));}
else throw Error("unexpected fake command " + args[0]);
`, { mode: 0o700 });
  chmodSync(executable, 0o700);
  const old = { path: process.env.PATH, url: process.env.GATTINI_OPENCODE_PRIVATE_SERVER_URL,
    calls: process.env.FAKE_CALLS, mode: process.env.FAKE_MODE, agent: process.env.FAKE_AGENT };
  process.env.PATH = `${bin}${delimiter}${old.path ?? ""}`;
  process.env.GATTINI_OPENCODE_PRIVATE_SERVER_URL = URL;
  process.env.FAKE_CALLS = calls;
  process.env.FAKE_MODE = mode;
  process.env.FAKE_AGENT = "reviewer";
  const review: ReviewRole = { runtime: "opencode", agent: "reviewer", model: "provider/model", directory,
    serverUrl: URL, permissions: RULES };
  const code = parseCodeRoleConfig({ runtime: "opencode", agent: "proposal", model: "provider/model", serverUrl: URL });
  return { directory, calls, review, code,
    entries: () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]) : [],
    restore: () => {
      for (const [key, value] of Object.entries({ PATH: old.path, GATTINI_OPENCODE_PRIVATE_SERVER_URL: old.url,
        FAKE_CALLS: old.calls, FAKE_MODE: old.mode, FAKE_AGENT: old.agent })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("private reviewer preflight and run target the configured service", async () => {
  const f = fixture();
  try {
    await preflightReview(f.review);
    const result = await runReview(f.review, "Inspect", () => {});
    assert.equal(result.sessionId, "ses_private123");
    const calls = f.entries();
    assert.equal(calls.some(args => args[0] === "service" || args[0] === "debug"), false);
    for (const args of calls.filter(args => ["api", "models", "run"].includes(args[0]!))) {
      assert.deepEqual(args.slice(1, 3), ["--server", URL]);
    }
    assert.equal(calls.some(args => args.includes("agent.list")), true);
    assert.equal(calls.some(args => args.includes(`location[directory]=${f.directory}`)), true);
  } finally { f.restore(); }
});

test("private agent discovery waits briefly for the requested project to load", async () => {
  const f = fixture("lag");
  try {
    await preflightReview(f.review);
    assert.equal(f.entries().filter(args => args.includes("agent.list")).length, 2);
  } finally { f.restore(); }
});

test("private proposal preflight and run use service policy and selected endpoint", async () => {
  const f = fixture();
  try {
    process.env.FAKE_AGENT = "proposal";
    await preflightProposal(f.code, f.directory);
    const result = await runProposal(f.code, f.directory, "Fix", () => {});
    assert.equal(result.sessionId, "ses_private123");
    assert.equal(f.entries().filter(args => args[0] === "run").length, 1);
    assert.equal(f.entries().every(args => args[0] === "--version" || args.includes("--server")), true);
  } finally { f.restore(); }
});

test("private endpoint, version, and effective policy mismatch fail before launch", async () => {
  for (const mode of ["version", "policy", "endpoint"]) {
    const f = fixture(mode);
    try {
      if (mode === "endpoint") process.env.GATTINI_OPENCODE_PRIVATE_SERVER_URL = "http://127.0.0.1:49194";
      await assert.rejects(preflightReview(f.review), /version|permissions|match/);
      assert.equal(f.entries().some(args => args[0] === "run"), false);
    } finally { f.restore(); }
  }
});

test("private session lookups reject wrong identity and interrupt only the exact session", async () => {
  const f = fixture();
  try {
    await assert.rejects(getReviewSession(f.review, "ses_bad-id"), /Invalid OpenCode session ID/);
    process.env.FAKE_MODE = "identity";
    await assert.rejects(getReviewSession(f.review, "ses_private123"), /identity/);
    process.env.FAKE_MODE = "good";
    assert.equal((await getReviewSession(f.review, "ses_private123")).outcome, "interrupted");
    assert.equal(await interruptReview(f.review, "ses_private123"), true);
    process.env.FAKE_AGENT = "proposal";
    assert.equal((await getCodeSession(f.code, f.directory, "ses_private123")).agent, "proposal");
    assert.equal(f.entries().filter(args => args.includes("session.interrupt")).length, 1);
    assert.equal(f.entries().filter(args => args[0] === "api").every(args => args.includes("--server")), true);
  } finally { f.restore(); }
});
