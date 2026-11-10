import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../src/cli.js");
const fake = path.resolve(here, "../../tools/fake-gemini.sh");
chmodSync(fake, 0o755);

function run(data: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [cli, "--data", data, ...args], { encoding: "utf8", env: { ...env } });
}

function json(result: ReturnType<typeof run>): Record<string, unknown> {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function dataDir(): string {
  return mkdtempSync(path.join(tmpdir(), "orch-accept-"));
}

function addGeminiProcess(data: string, name: string): void {
  const added = json(run(data, [
    "profile-add",
    "--name",
    name,
    "--account",
    name,
    "--identity",
    "sandbox",
    "--role",
    "delegated",
    "--opt-in",
    "--execution",
    "gemini-process",
    "--gemini-bin",
    fake,
  ]));
  assert.equal(added.execution, "gemini-process");
  assert.equal(added.impersonatesGemini, false);
}

function state(data: string): {
  tasks: {
    id: string;
    attemptId: string | null;
    goal: string;
    state: string;
    reason: string | null;
    pid: number | null;
    poolId: string | null;
    parentId: string | null;
    kind: string;
    verification: string;
    dependsOn: string[];
    lateResultRejected: boolean;
    sessionId: string | null;
    argv: string[];
  }[];
  pools: { id: string; maxConcurrent: number; running: number; permissions: string[]; tasksCreated: number }[];
  profiles: { sessionDir: string; name: string }[];
} {
  return JSON.parse(readFileSync(path.join(data, "state.json"), "utf8")) as ReturnType<typeof state>;
}

function killTree(data: string): void {
  const db = state(data);
  for (const task of db.tasks) {
    if (!task.pid) continue;
    try {
      process.kill(-task.pid, "SIGKILL");
    } catch {
      try {
        process.kill(task.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
}

async function mcpSession(data: string): Promise<{
  call: (id: number, method: string, params?: unknown) => Promise<{ id: number; result?: { content?: { text: string }[]; tools?: { name: string }[] }; error?: { message: string } }>;
  close: () => void;
}> {
  const child: ChildProcess = spawn(process.execPath, [cli, "--data", data, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const pending = new Map<number, (message: { id: number; result?: { content?: { text: string }[]; tools?: { name: string }[] } }) => void>();
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.trim()) continue;
      const message = JSON.parse(part) as { id: number; result?: { content?: { text: string }[]; tools?: { name: string }[] } };
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const call = (id: number, method: string, params?: unknown) =>
    new Promise<{ id: number; result?: { content?: { text: string }[]; tools?: { name: string }[] }; error?: { message: string } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`mcp timeout ${method}`)), 10000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return {
    call,
    close: () => child.kill("SIGKILL"),
  };
}

test("MCP initialize, tools/list, delegate, status, wait, message, and cancel", async () => {
  const data = dataDir();
  addGeminiProcess(data, "gem");
  const mcp = await mcpSession(data);
  try {
    const init = await mcp.call(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "acceptance", version: "0" },
    });
    assert.equal((init.result as { protocolVersion?: string } | undefined)?.protocolVersion, "2025-11-25");
    const listed = await mcp.call(2, "tools/list");
    const names = (listed.result?.tools ?? []).map((tool) => tool.name).sort();
    for (const required of ["delegate", "status", "wait", "message", "cancel"]) {
      assert.ok(names.includes(required), names.join(","));
    }
    const delegated = await mcp.call(3, "tools/call", {
      name: "delegate",
      arguments: { profile: "gem", goal: "plain-ok", check: "" },
    });
    const task = JSON.parse(delegated.result?.content?.[0]?.text ?? "{}") as { id: string; state: string };
    assert.ok(task.id);
    const waited = await mcp.call(4, "tools/call", { name: "wait", arguments: { id: task.id, timeoutMs: "4000" } });
    const done = JSON.parse(waited.result?.content?.[0]?.text ?? "{}") as { state: string; verification: string; timedOut: boolean };
    assert.equal(done.timedOut, false);
    assert.equal(done.state, "completed_unverified");
    assert.equal(done.verification, "completed_unverified");
    const status = await mcp.call(5, "tools/call", { name: "status", arguments: { id: task.id } });
    const viewed = JSON.parse(status.result?.content?.[0]?.text ?? "{}") as { state: string };
    assert.equal(viewed.state, "completed_unverified");
    const message = await mcp.call(6, "tools/call", {
      name: "message",
      arguments: { id: task.id, text: "steer this", requestId: "req-1" },
    });
    const receipt = JSON.parse(message.result?.content?.[0]?.text ?? "{}") as { received: boolean; applied: boolean; restarted: boolean };
    assert.equal(receipt.received, true);
    assert.equal(receipt.applied, false);
    assert.equal(receipt.restarted, false);
    const again = await mcp.call(7, "tools/call", {
      name: "message",
      arguments: { id: task.id, text: "steer this", requestId: "req-1" },
    });
    const duplicate = JSON.parse(again.result?.content?.[0]?.text ?? "{}") as { duplicate: boolean; restarted: boolean };
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.restarted, false);
    const hang = await mcp.call(8, "tools/call", { name: "delegate", arguments: { profile: "gem", goal: "hang-child" } });
    const hanging = JSON.parse(hang.result?.content?.[0]?.text ?? "{}") as { id: string };
    const cancelled = await mcp.call(9, "tools/call", {
      name: "cancel",
      arguments: { id: hanging.id, wait: "true", timeoutMs: "4000" },
    });
    const cancelBody = JSON.parse(cancelled.result?.content?.[0]?.text ?? "{}") as { state: string; code: number };
    assert.equal(cancelBody.code, 0);
    assert.equal(cancelBody.state, "cancelled");
  } finally {
    mcp.close();
    killTree(data);
  }
});

test("supervisor DAG shares one pool and distinguishes verified from unverified", async () => {
  const data = dataDir();
  addGeminiProcess(data, "gem");
  const plan = {
    profile: "gem",
    goal: "root",
    depthRemaining: 2,
    maxConcurrent: 1,
    maxTasks: 8,
    permissions: ["read", "edit"],
    wallSec: 30,
    children: [
      { key: "a", goal: "write-marker", check: "check:file-exists:marker.txt" },
      { key: "b", goal: "plain-ok", dependsOn: ["a"] },
      { key: "bad", goal: "needs-network", permissions: ["network"] },
      { key: "deep", goal: "too-deep", children: [{ key: "nope", goal: "nope", children: [{ key: "z", goal: "too-far" }] }] },
      { key: "nested", goal: "inner", children: [{ key: "leaf", goal: "leaf-ok" }] },
    ],
  };
  writeFileSync(path.join(data, "plan.json"), JSON.stringify(plan));
  const root = json(run(data, ["supervise", "--plan", path.join(data, "plan.json")]));
  const finished = json(run(data, ["wait", "--task", String(root.id), "--timeout-ms", "8000"]));
  assert.notEqual(finished.state, "running");
  const db = state(data);
  assert.equal(db.pools.length, 1);
  assert.equal(db.pools[0].maxConcurrent, 1);
  assert.ok(db.tasks.filter((task) => task.poolId === db.pools[0].id).length >= 5);
  assert.equal(JSON.stringify(db.tasks).includes("\"maxConcurrent\""), false);
  const byGoal = (goal: string) => db.tasks.find((task) => task.goal === goal);
  assert.equal(byGoal("write-marker")?.verification, "completed_unverified");
  assert.equal(byGoal("write-marker")?.state, "completed_unverified");
  assert.equal(byGoal("write-marker")?.reason, "file_exists_is_plumbing_not_verification");
  assert.equal(byGoal("plain-ok")?.verification, "completed_unverified");
  assert.equal(byGoal("plain-ok")?.state, "completed_unverified");
  assert.equal(byGoal("plain-ok")?.reason, "exit_status_is_not_verification");
  assert.notEqual(byGoal("write-marker")?.reason, byGoal("plain-ok")?.reason);
  assert.equal(byGoal("needs-network")?.reason, "permission_rejected");
  assert.equal(byGoal("needs-network")?.pid, null);
  assert.equal(byGoal("nope")?.reason, "depth_exceeded");
  assert.equal(byGoal("too-far"), undefined);
  assert.equal(byGoal("leaf-ok")?.state, "completed_unverified");
  assert.ok(byGoal("plain-ok")?.dependsOn.includes(String(byGoal("write-marker")?.id)));
  const marker = json(run(data, ["delegate", "--profile", "gem", "--goal", "write-marker", "--check", "check:file-exists:marker.txt"]));
  const plumbing = json(run(data, ["wait", "--task", String(marker.id), "--timeout-ms", "4000"]));
  assert.equal(plumbing.verification, "completed_unverified");
  assert.equal(plumbing.reason, "file_exists_is_plumbing_not_verification");
  const plain = json(run(data, ["delegate", "--profile", "gem", "--goal", "plain-ok"]));
  const unverified = json(run(data, ["wait", "--task", String(plain.id), "--timeout-ms", "4000"]));
  assert.equal(unverified.state, "completed_unverified");
  assert.equal(unverified.verification, "completed_unverified");
  killTree(data);
});

test("provider concurrency slot is one ancestor pool, not one allowance per child", () => {
  const data = dataDir();
  addGeminiProcess(data, "gem");
  const plan = {
    profile: "gem",
    goal: "root",
    depthRemaining: 1,
    maxConcurrent: 1,
    maxTasks: 4,
    permissions: ["read"],
    wallSec: 30,
    children: [
      { key: "hold", goal: "hang-child" },
      { key: "next", goal: "plain-ok" },
    ],
  };
  writeFileSync(path.join(data, "plan.json"), JSON.stringify(plan));
  json(run(data, ["supervise", "--plan", path.join(data, "plan.json")]));
  const db = state(data);
  assert.equal(db.pools.length, 1);
  assert.equal(db.pools[0].maxConcurrent, 1);
  assert.equal(db.pools[0].running, 1);
  const running = db.tasks.filter((task) => task.kind === "turn" && task.state === "running");
  const queued = db.tasks.filter((task) => task.state === "queued");
  assert.equal(running.length, 1);
  assert.equal(queued.length, 1);
  assert.equal(running[0].poolId, queued[0].poolId);
  killTree(data);
});

test("cancel kills the gemini process tree and restart does not resurrect success", () => {
  const data = dataDir();
  addGeminiProcess(data, "gem");
  const hanging = json(run(data, ["delegate", "--profile", "gem", "--goal", "hang-child"]));
  const before = state(data);
  const task = before.tasks.find((item) => item.id === hanging.id);
  assert.ok(task?.pid);
  const childFile = path.join(before.profiles[0].sessionDir, "children", `${task?.attemptId}.pid`);
  const childDeadline = Date.now() + 3000;
  while (!exists(childFile) && Date.now() < childDeadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  const childPid = Number(readFileSync(childFile, "utf8"));
  assert.equal(alive(childPid), true);
  const cancelled = json(run(data, ["cancel", "--task", String(hanging.id), "--wait", "--timeout-ms", "4000"]));
  assert.equal(cancelled.code, 0);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(alive(childPid), false);
  assert.equal(alive(Number(task?.pid)), false);
  const stream = path.join(before.profiles[0].sessionDir, "streams", `${task?.attemptId}.ndjson`);
  writeFileSync(stream, `${JSON.stringify({ event: "result", status: "success", session_id: "123e4567-e89b-12d3-a456-426614174000", response: "late" })}\n`, { flag: "a" });
  const viewed = json(run(data, ["status", "--task", String(hanging.id)]));
  assert.equal(viewed.state, "cancelled");
  assert.equal(viewed.lateResultRejected, true);
  const reconciled = json(run(data, ["reconcile"]));
  assert.equal(reconciled.spawned, 0);
  const again = json(run(data, ["status", "--task", String(hanging.id)]));
  assert.equal(again.state, "cancelled");
});

test("abrupt SIGKILL keeps ownership and idempotency without a second spawn", () => {
  const data = dataDir();
  addGeminiProcess(data, "gem");
  const crashed = run(data, ["delegate", "--profile", "gem", "--goal", "hang-child", "--idempotency-key", "job-1"], {
    ...process.env,
    ORCHESTRA_CRASH_AT: "after_gemini_spawn",
  });
  assert.equal(crashed.signal, "SIGKILL");
  const db = state(data);
  const task = db.tasks.find((item) => item.goal === "hang-child");
  assert.ok(task?.pid);
  const spawnLog = path.join(db.profiles[0].sessionDir, "gemini-spawns.log");
  const spawnDeadline = Date.now() + 3000;
  while (!exists(spawnLog) && Date.now() < spawnDeadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  const spawns = readFileSync(spawnLog, "utf8").trim().split("\n");
  assert.equal(spawns.length, 1);
  const replay = json(run(data, ["delegate", "--profile", "gem", "--goal", "hang-child", "--idempotency-key", "job-1"]));
  assert.equal(replay.id, task?.id);
  assert.equal(readFileSync(path.join(db.profiles[0].sessionDir, "gemini-spawns.log"), "utf8").trim().split("\n").length, 1);
  const reconciled = json(run(data, ["reconcile"]));
  assert.equal(reconciled.spawned, 0);
  assert.equal(readFileSync(path.join(db.profiles[0].sessionDir, "gemini-spawns.log"), "utf8").trim().split("\n").length, 1);
  const conflict = run(data, ["delegate", "--profile", "gem", "--goal", "different-goal", "--idempotency-key", "job-1"]);
  assert.equal(conflict.status, 3);
  json(run(data, ["cancel", "--task", String(task?.id), "--wait", "--timeout-ms", "4000"]));
  killTree(data);
});

test("fake gemini executable is parsed and resume is pinned to its session id", () => {
  const data = dataDir();
  addGeminiProcess(data, "gem");
  const first = json(run(data, ["delegate", "--profile", "gem", "--goal", "plain-ok"]));
  const done = json(run(data, ["wait", "--task", String(first.id), "--timeout-ms", "4000"]));
  assert.equal(done.liveGoogleAuthVerified, false);
  assert.match(String(done.sessionId), /^[0-9a-f-]{36}$/i);
  const argvLog = readFileSync(path.join(state(data).profiles[0].sessionDir, "gemini-argv.log"), "utf8");
  assert.match(argvLog, /--output-format/);
  assert.match(argvLog, /stream-json/);
  assert.equal(argvLog.includes("--yolo"), false);
  const resumed = json(run(data, ["resume", "--task", String(first.id)]));
  json(run(data, ["wait", "--task", String(resumed.id), "--timeout-ms", "4000"]));
  const after = readFileSync(path.join(state(data).profiles[0].sessionDir, "gemini-argv.log"), "utf8");
  assert.match(after, new RegExp(`--resume","${done.sessionId}"`));
  const doctor = json(run(data, ["doctor"]));
  const agents = doctor.agents as { geminiCli: { isolationWorkerImpersonatesGemini: boolean; liveExecution: boolean } };
  assert.equal(agents.geminiCli.isolationWorkerImpersonatesGemini, false);
  assert.equal(agents.geminiCli.liveExecution, false);
  killTree(data);
});

function exists(file: string): boolean {
  return existsSync(file);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
