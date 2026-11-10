import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../src/cli.js");
const fake = path.resolve(here, "../../tools/fake-gemini.sh");
chmodSync(fake, 0o755);

function run(data: string, args: string[]) {
  return spawnSync(process.execPath, [cli, "--data", data, ...args], { encoding: "utf8" });
}

function addProfile(data: string): void {
  const result = run(data, [
    "profile-add", "--name", "gem", "--account", "gem", "--identity", "sandbox",
    "--role", "delegated", "--opt-in", "--execution", "gemini-process", "--gemini-bin", fake,
  ]);
  assert.equal(result.status, 0, result.stdout);
}

const checkArgv = ["node", "-e", "const fs=require('fs'); if (fs.readFileSync('marker.txt','utf8').trim()!=='marked') process.exit(3);"];

function taskContract(id: string, goal: string) {
  return {
    schema_version: "1.0",
    id,
    parent_id: null,
    goal,
    role: "worker",
    routing: { account_profile: "gem" },
    acceptance_tests: [{ id: "marker-content", description: "Service reads the marker.", argv: checkArgv, required: true }],
    budget: { tokens: null, usd: null, wall_time_sec: 30, max_concurrent_workers: 1, max_tasks: 4 },
    permissions: ["read", "edit"],
    depth_remaining: 0,
  };
}

test("CLI and MCP reject invalid contracts and accept a mapped valid task", async () => {
  const data = mkdtempSync(path.join(tmpdir(), "orch-contract-"));
  addProfile(data);
  const bad = path.join(data, "bad.json");
  writeFileSync(bad, JSON.stringify({ schema_version: "1.0", goal: "x", unexpected: true }));
  const rejected = run(data, ["submit-task", "--file", bad]);
  assert.equal(rejected.status, 4);
  assert.match(rejected.stdout, /contract_invalid/);
  const tokens = path.join(data, "tokens.json");
  const withTokens = taskContract("job-tokens", "write-marker");
  (withTokens.budget as { tokens: number | null }).tokens = 5;
  writeFileSync(tokens, JSON.stringify(withTokens));
  const tokenRejected = run(data, ["submit-task", "--file", tokens]);
  assert.equal(tokenRejected.status, 4);
  assert.match(tokenRejected.stdout, /contract_invalid/);

  const good = path.join(data, "good.json");
  writeFileSync(good, JSON.stringify(taskContract("job-ok", "write-marker")));
  const created = JSON.parse(run(data, ["submit-task", "--file", good]).stdout) as { id: string };
  const done = JSON.parse(run(data, ["wait", "--task", created.id, "--timeout-ms", "4000"]).stdout) as { state: string; verification: string; reason: string };
  assert.equal(done.state, "verified");
  assert.equal(done.verification, "verified");
  assert.equal(done.reason, "independent_acceptance_check");

  const preexisting = path.join(data, "pre.json");
  const home = JSON.parse(readFileSync(path.join(data, "state.json"), "utf8")).profiles[0].homeDir as string;
  writeFileSync(path.join(home, "marker.txt"), "marked\n");
  writeFileSync(preexisting, JSON.stringify(taskContract("job-pre", "plain-ok")));
  const preId = JSON.parse(run(data, ["submit-task", "--file", preexisting]).stdout).id as string;
  const preDone = JSON.parse(run(data, ["wait", "--task", preId, "--timeout-ms", "4000"]).stdout) as { verification: string; reason: string };
  assert.equal(preDone.verification, "completed_unverified");
  assert.equal(preDone.reason, "preexisting_or_unchanged_artifact");

  writeFileSync(path.join(home, "marker.txt"), "marked\nchanged-after\n");
  const stale = JSON.parse(run(data, ["status", "--task", created.id]).stdout) as { verification: string; reason: string; state: string };
  assert.equal(stale.state, "completed_unverified");
  assert.equal(stale.verification, "completed_unverified");
  assert.equal(stale.reason, "stale_evidence");

  const selfClaim = path.join(data, "self.json");
  writeFileSync(selfClaim, JSON.stringify({
    schema_version: "1.0", id: "job-ok", parent_id: null, status: "completed", summary: "I verified myself",
    verification: { accepted: true },
  }));
  const claim = run(data, ["submit-result", "--file", selfClaim]);
  assert.equal(claim.status, 4);
  assert.match(claim.stdout, /contract_invalid/);
  const partial = path.join(data, "partial.json");
  writeFileSync(partial, JSON.stringify({
    schema_version: "1.0", id: "job-ok", parent_id: null, status: "partial", summary: "not verified",
    verification: { accepted: false },
  }));
  const stored = JSON.parse(run(data, ["submit-result", "--file", partial]).stdout) as { mappedToVerified: boolean; verification: string };
  assert.equal(stored.mappedToVerified, false);
  assert.notEqual(stored.verification, "verified");

  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [cli, "--data", data, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const pending = new Map<number, (message: { result?: { content?: { text: string }[]; isError?: boolean } }) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.trim()) continue;
      const message = JSON.parse(part) as { id: number; result?: { content?: { text: string }[]; isError?: boolean } };
      pending.get(message.id)?.(message);
    }
  });
  const call = (id: number, method: string, params?: unknown) => new Promise<{ result?: { content?: { text: string }[]; isError?: boolean } }>((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const invalid = await call(1, "tools/call", { name: "submit_task", arguments: { taskJson: JSON.stringify({ schema_version: "1.0", extra: true }) } });
  assert.equal(invalid.result?.isError, true);
  child.kill("SIGKILL");
});

test("skill export is a physical copy under the staging root only", () => {
  const data = mkdtempSync(path.join(tmpdir(), "orch-export-"));
  const staging = path.join(data, "stage");
  const dry = run(data, ["skills-export", "--adapter", "codex", "--staging-root", staging, "--dry-run"]);
  assert.equal(dry.status, 0, dry.stdout);
  const dryBody = JSON.parse(dry.stdout) as { wrote: boolean; dryRun: boolean };
  assert.equal(dryBody.wrote, false);
  assert.equal(dryBody.dryRun, true);
  assert.equal(existsSync(path.join(staging, "codex")), false);
  const wrote = run(data, ["skills-export", "--adapter", "gemini", "--staging-root", staging]);
  assert.equal(wrote.status, 0, wrote.stdout);
  const skill = path.join(staging, "gemini", "worker-result", "SKILL.md");
  assert.equal(lstatSync(skill).isSymbolicLink(), false);
  assert.match(readFileSync(skill, "utf8"), /Do not delegate/);
  const again = run(data, ["skills-export", "--adapter", "gemini", "--staging-root", staging]);
  assert.equal(again.status, 4);
  assert.match(again.stdout, /export_collision/);
  const escape = run(data, ["skills-export", "--adapter", "codex", "--staging-root", staging, "--dest", path.join(staging, "..", "outside")]);
  assert.equal(escape.status, 4);
  assert.match(escape.stdout, /path_traversal/);
  const link = path.join(staging, "linked");
  symlinkSync("/tmp", link);
  const linked = run(data, ["skills-export", "--adapter", "cursor", "--staging-root", staging, "--dest", link]);
  assert.equal(linked.status, 4);
  assert.match(linked.stdout, /symlink_dest_refused/);
  const live = run(data, ["skills-export", "--adapter", "codex", "--staging-root", path.join(process.env.HOME ?? "/tmp", ".agents")]);
  assert.equal(live.status, 4);
  assert.match(live.stdout, /live_profile_forbidden|path_traversal|symlink_dest_refused/);
});
