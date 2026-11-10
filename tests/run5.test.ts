import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { reliabilityBench } from "../src/bench.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../src/cli.js");
const fake = path.resolve(here, "../../tools/fake-gemini.sh");
const fakeAcp = path.resolve(here, "../src/fake-acp.js");
chmodSync(fake, 0o755);

function run(data: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [cli, "--data", data, ...args], { encoding: "utf8", env });
}

function add(data: string, name = "gem"): void {
  const result = run(data, ["profile-add", "--name", name, "--account", name, "--identity", "sandbox", "--role", "delegated", "--opt-in", "--execution", "gemini-process", "--gemini-bin", fake]);
  assert.equal(result.status, 0, result.stdout);
}

test("compact MCP is smaller and run falls back to a task id", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "orch-compact-"));
  add(data);
  const measure = async (compact: boolean) => {
    const child = spawn(process.execPath, [cli, "--data", data, "mcp", ...(compact ? ["--compact"] : [])], { stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    const pending = new Map<number, (message: unknown) => void>();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (!part.trim()) continue;
        const message = JSON.parse(part) as { id: number };
        pending.get(message.id)?.(message);
      }
    });
    const call = (id: number, method: string, params?: unknown) => new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(method)), 8000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    await call(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "m", version: "0" } });
    const listed = await call(2, "tools/list") as { result: unknown };
    const listBytes = Buffer.byteLength(JSON.stringify(listed.result));
    const policy = path.join(data, compact ? "policy-fast.json" : "unused.json");
    if (compact) writeFileSync(policy, JSON.stringify({ profile: "gem", timeoutMs: 4000 }));
    const round = compact
      ? await call(3, "tools/call", { name: "delegate_and_wait", arguments: { goal: "plain-ok", policy } })
      : await call(3, "tools/call", { name: "delegate", arguments: { profile: "gem", goal: "plain-ok" } });
    const roundBytes = Buffer.byteLength(JSON.stringify(round));
    child.kill("SIGKILL");
    return { listBytes, roundBytes, listTokens: Math.ceil(listBytes / 4), roundTokens: Math.ceil(roundBytes / 4) };
  };
  const full = await measure(false);
  const compact = await measure(true);
  const hang = spawn(process.execPath, [cli, "--data", data, "mcp", "--compact"], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const waiters = new Map<number, (message: { result?: { content?: { text: string }[] } }) => void>();
  hang.stdout.setEncoding("utf8");
  hang.stdout.on("data", (chunk: string) => {
    buf += chunk;
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.trim()) continue;
      const message = JSON.parse(part) as { id: number; result?: { content?: { text: string }[] } };
      waiters.get(message.id)?.(message);
    }
  });
  const rpc = (id: number, method: string, params?: unknown) => new Promise<{ result?: { content?: { text: string }[] } }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`rpc timeout ${method}`)), 8000);
    waiters.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    hang.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const hangPolicy = path.join(data, "policy-hang.json");
  const outcome = path.join(data, "outcome.md");
  writeFileSync(hangPolicy, JSON.stringify({ profile: "gem", timeoutMs: 700 }));
  writeFileSync(outcome, "hang-child\n");
  const listed = await rpc(1, "tools/list");
  const names = ((listed.result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map((tool) => tool.name).sort();
  assert.deepEqual(names, ["cancel", "delegate_and_wait", "message", "status"]);
  const rushed = await rpc(2, "tools/call", { name: "delegate_and_wait", arguments: { taskFile: outcome, policy: hangPolicy } });
  const body = JSON.parse(rushed.result?.content?.[0]?.text ?? "{}") as { id: string; status: string; resultPath: string };
  assert.deepEqual(Object.keys(body).sort(), ["id", "resultPath", "status"]);
  assert.equal(body.status.includes("\n"), false);
  assert.equal(body.status, "running");
  assert.ok(body.resultPath.endsWith(`${body.id}.json`));
  const brief = await rpc(3, "tools/call", { name: "status", arguments: { id: body.id } });
  const briefBody = JSON.parse(brief.result?.content?.[0]?.text ?? "{}") as { id: string; status: string; resultPath: string };
  assert.deepEqual(Object.keys(briefBody).sort(), ["id", "resultPath", "status"]);
  assert.ok(briefBody.resultPath.endsWith(`${body.id}.json`));
  hang.kill("SIGKILL");
  hang.unref();
  const snippet = readFileSync(path.resolve(here, "../../templates/AGENTS-compact.md"), "utf8");
  assert.ok(snippet.split("\n").length < 40);
  assert.match(snippet, /Supervise the outcome in `outcome.md` and wait/);
  assert.match(snippet, /Do not poll in the chat/);
  const report = { full, compact, listByteRatio: Number((full.listBytes / compact.listBytes).toFixed(2)), snippetLines: snippet.split("\n").length };
  writeFileSync("/workspace/artifacts/mcp-token-overhead.json", JSON.stringify(report, null, 2));
  assert.ok(compact.listBytes < full.listBytes);
});

test("pacing rests an account and does not evade a restriction", () => {
  const data = mkdtempSync(path.join(tmpdir(), "orch-pace-"));
  add(data, "a");
  add(data, "b");
  assert.equal(run(data, ["tune", "--daily", "1"]).status, 0);
  const first = JSON.parse(run(data, ["delegate", "--profile", "a", "--goal", "plain-ok"]).stdout) as { id: string; state: string };
  assert.equal(first.state, "running");
  const second = JSON.parse(run(data, ["delegate", "--profile", "a", "--goal", "plain-ok-2"]).stdout) as { state: string; reason: string; profile: string };
  assert.equal(second.state, "queued");
  assert.equal(second.reason, "daily_rest");
  assert.equal(second.profile, "a");
  const other = JSON.parse(run(data, ["delegate", "--profile", "b", "--goal", "plain-ok"]).stdout) as { profile: string; state: string };
  assert.equal(other.profile, "b");
  assert.notEqual(other.state, "queued");
  const hour = new Date().getUTCHours();
  run(data, ["tune", "--quiet", `${hour}-${hour + 1}`, "--daily", "100"]);
  const quiet = JSON.parse(run(data, ["delegate", "--profile", "b", "--goal", "later"]).stdout) as { reason: string; profile: string };
  assert.equal(quiet.reason, "quiet_hours");
  assert.equal(quiet.profile, "b");
  const doctor = JSON.parse(run(data, ["doctor"]).stdout) as { banGuarantee: boolean; accounts: unknown[] };
  assert.equal(doctor.banGuarantee, false);
  assert.ok(doctor.accounts.length >= 2);
});

test("handoff card, webhook, and ACP skeleton do not claim Muse", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "orch-hand-"));
  add(data);
  const card = JSON.parse(run(data, ["handoff", "--profile", "gem", "--goal", "carry this", "--constraints", "no UI automation", "--done-check", "human says done", "--timeout-ms", "5000"]).stdout) as { id: string; state: string; cardPath: string; museIntegration: boolean };
  assert.equal(card.state, "waiting_on_human");
  assert.equal(card.museIntegration, false);
  assert.match(readFileSync(card.cardPath, "utf8"), /carry this/);
  const server = http.createServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const postedOut = await new Promise<string>((resolve) => {
    const child = spawn(process.execPath, [cli, "--data", data, "handoff-webhook", "--task", card.id, "--url", `http://127.0.0.1:${port}/hook`], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("close", () => resolve(stdout));
  });
  const posted = JSON.parse(postedOut) as { status: number; museIntegration: boolean };
  assert.equal(posted.status, 204);
  assert.equal(posted.museIntegration, false);
  server.close();
  const remote = run(data, ["handoff-webhook", "--task", card.id, "--url", "http://example.com/hook"]);
  assert.equal(remote.status, 4);
  writeFileSync(path.join(data, "reply.json"), JSON.stringify({ schema_version: "1.0", id: card.id, parent_id: null, status: "partial", summary: "human reply", verification: { accepted: false } }));
  const ingested = JSON.parse(run(data, ["handoff-ingest", "--task", card.id, "--file", path.join(data, "reply.json")]).stdout) as { verification: string; museIntegration: boolean };
  assert.equal(ingested.verification, "completed_unverified");
  assert.equal(ingested.museIntegration, false);
  const acp = JSON.parse(run(data, ["acp-check", "--bin", fakeAcp]).stdout) as { permission: string; question: string; hung: boolean; muse: boolean };
  assert.equal(acp.permission, "reject-once");
  assert.equal(acp.question, "cancelled");
  assert.equal(acp.hung, false);
  assert.equal(acp.muse, false);
});

test("state commit crash leaves a readable file and one later task", () => {
  const data = mkdtempSync(path.join(tmpdir(), "orch-crash-write-"));
  add(data);
  const crashed = run(data, ["delegate", "--profile", "gem", "--goal", "plain-ok"], { ...process.env, ORCHESTRA_CRASH_AT: "during_state_write" });
  assert.equal(crashed.signal, "SIGKILL");
  const raw = readFileSync(path.join(data, "state.json"), "utf8");
  const db = JSON.parse(raw) as { tasks: unknown[] };
  assert.equal(db.tasks.length, 0);
  const again = run(data, ["delegate", "--profile", "gem", "--goal", "plain-ok"]);
  assert.equal(again.status, 0, again.stdout);
  const after = JSON.parse(readFileSync(path.join(data, "state.json"), "utf8")) as { tasks: { id: string }[] };
  assert.equal(after.tasks.length, 1);
});

test("reliability bench reports a measured ratio without inventing 2x", { timeout: 120_000 }, async () => {
  const report = await reliabilityBench(fake);
  writeFileSync("/workspace/artifacts/reliability-bench.json", JSON.stringify(report, null, 2));
  writeFileSync("/workspace/artifacts/reliability-bench.md", [
    "# Reliability bench",
    "",
    `Baseline verified ${report.baseline && (report.baseline as { verified: number }).verified} of ${(report.baseline as { submitted: number }).submitted}.`,
    `Pool verified ${(report.pooled as { verified: number }).verified} of ${(report.pooled as { submitted: number }).submitted}.`,
    `Ratio: ${String(report.verifiedRatio)}. claim2x: ${String(report.claim2x)}.`,
    "",
    String(report.note),
  ].join("\n"));
  assert.equal((report.baseline as { duplicated: number }).duplicated, 0);
  assert.equal((report.pooled as { duplicated: number }).duplicated, 0);
  assert.equal(typeof report.verifiedRatio === "number" || report.verifiedRatio === null, true);
});
