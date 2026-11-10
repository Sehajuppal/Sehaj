import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestra } from "./service.js";

const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bench/fault-script.json");

interface Row {
  id: string;
  launched: number;
  verified: number;
  profile: string | null;
  state: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function profilePaths(dataDir: string, name: string): { homeDir: string; sessionDir: string } {
  const db = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8")) as { profiles: { name: string; homeDir: string; sessionDir: string }[] };
  const profile = db.profiles.find((item) => item.name === name);
  if (!profile) throw new Error(`missing profile ${name}`);
  return profile;
}

function check(home: string): { id: string; argv: string[]; required: boolean }[] {
  return [{ id: "marker", argv: [process.execPath, "-e", `const fs=require('fs');process.exit(fs.existsSync(${JSON.stringify(path.join(home, "bench-marker.txt"))})&&fs.readFileSync(${JSON.stringify(path.join(home, "bench-marker.txt"))},'utf8').includes('marked')?0:2)`], required: true }];
}

async function pass(bin: string, recovery: boolean): Promise<{ rows: Row[]; earlyRetryBlocked: boolean; sigtermIgnoredThenStopped: boolean; restrictedDidNotRotate: boolean }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-fault-"));
  const orchestra = new Orchestra(dataDir);
  await orchestra.addProfile({
    name: "gemini-a",
    accountLabel: "sandbox-a",
    identityClass: "sandbox",
    role: "delegated",
    schedulingOptIn: true,
    execution: "gemini-process",
    geminiBin: bin,
  });
  await orchestra.addProfile({
    name: "gemini-b",
    accountLabel: "sandbox-b",
    identityClass: "sandbox",
    role: "delegated",
    schedulingOptIn: true,
    execution: "gemini-process",
    geminiBin: bin,
  });
  await orchestra.tune({
    poolEnabled: recovery,
    recoveryEnabled: recovery,
    cancellationEnabled: recovery,
    idempotencyEnabled: recovery,
    deterministicBackoff: true,
    stallMs: 400,
    maxRetries: 2,
    providerCeiling: 20,
  });
  const home = profilePaths(dataDir, "gemini-a").homeDir;
  const sessionDir = profilePaths(dataDir, "gemini-a").sessionDir;
  const tests = check(home);
  const rows: Row[] = [];
  const record = (id: string, tasks: Record<string, unknown>[]): void => {
    rows.push({
      id,
      launched: tasks.length,
      verified: tasks.filter((task) => task.verification === "verified").length,
      profile: tasks.length === 1 ? String(tasks[0]?.profile ?? "") : tasks.map((task) => String(task.profile)).join(","),
      state: tasks.map((task) => String(task.state)).join(","),
    });
  };

  const crash = await orchestra.delegate({ profile: "gemini-a", goal: "write-bench-marker", mode: "plan:crash,ok", acceptanceTests: tests });
  record("worker_crash_mid_task", [await orchestra.wait(String(crash.id), 5000)]);

  await orchestra.tune({ crashNext: "after_enqueue" });
  const enqueued = await orchestra.delegate({ profile: "gemini-a", goal: "write-bench-marker", mode: "plan:ok", acceptanceTests: tests });
  const resumed = new Orchestra(dataDir);
  record("scheduler_kill_after_enqueue", [await resumed.wait(String(enqueued.id), 4000)]);

  const spawned = await orchestra.delegate({ profile: "gemini-a", goal: "write-bench-marker", mode: "plan:ok", acceptanceTests: tests });
  await new Promise((resolve) => setTimeout(resolve, 350));
  const adopted = new Orchestra(dataDir);
  record("scheduler_kill_after_spawn", [await adopted.wait(String(spawned.id), 3000)]);

  await orchestra.tune({ providerCeiling: 1 });
  const holder = await orchestra.delegate({ profile: "gemini-a", goal: "hold", mode: "plan:hang" });
  const queued = await orchestra.delegate({ profile: "gemini-a", goal: "write-bench-marker", mode: "plan:ok", acceptanceTests: tests });
  await orchestra.cancel(String(queued.id), { wait: true, timeoutMs: 1000 });
  record("cancel_during_queue", [await orchestra.status(String(queued.id))]);
  await orchestra.cancel(String(holder.id), { wait: true, timeoutMs: 2000 });
  await orchestra.tune({ providerCeiling: 20 });

  const running = await orchestra.delegate({ profile: "gemini-a", goal: "hold-run", mode: "plan:hang" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await orchestra.cancel(String(running.id), { wait: true, timeoutMs: 2000 });
  record("cancel_during_run", [await orchestra.status(String(running.id))]);

  const backing = await orchestra.delegate({ profile: "gemini-a", goal: "write-bench-marker", mode: "plan:429,ok", acceptanceTests: tests });
  await new Promise((resolve) => setTimeout(resolve, 250));
  await orchestra.cancel(String(backing.id), { wait: true, timeoutMs: 1000 });
  const afterBackoff = await orchestra.wait(String(backing.id), 800);
  record("cancel_during_backoff", [afterBackoff]);

  const late = await orchestra.delegate({ profile: "gemini-a", goal: "late", mode: "plan:hang" });
  await orchestra.cancel(String(late.id), { wait: false });
  const lateView = await orchestra.status(String(late.id));
  if (lateView.pid) {
    try { process.kill(Number(lateView.pid), "SIGKILL"); } catch { /* already gone */ }
  }
  const attemptId = String(lateView.attemptId ?? "");
  if (attemptId) {
    const stream = path.join(sessionDir, "streams", `${attemptId}.ndjson`);
    fs.mkdirSync(path.dirname(stream), { recursive: true });
    fs.appendFileSync(stream, `${JSON.stringify({ type: "result", status: "success", response: "late", session_id: "late", stats: { models: {} } })}\n`);
  }
  const lateObserver = new Orchestra(dataDir);
  record("late_success_after_cancel", [await lateObserver.status(String(late.id))]);

  const limited = await orchestra.delegate({ profile: "gemini-a", goal: "write-bench-marker", mode: "plan:429,ok", acceptanceTests: tests });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const spawnLog = path.join(sessionDir, "gemini-spawns.log");
  const before = fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean).length : 0;
  await orchestra.schedule();
  const during = fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean).length : 0;
  const earlyRetryBlocked = during === before;
  record("retry_after", [await orchestra.wait(String(limited.id), 4000)]);

  await orchestra.reportError("gemini-a", { httpStatus: 401, code: "invalid_api_key", message: "expired" });
  const auth = await orchestra.delegate({ profile: "gemini-a", goal: "write-bench-marker", mode: "plan:ok", acceptanceTests: tests });
  record("expired_auth", [auth]);

  const stubborn = await orchestra.delegate({ profile: "gemini-b", goal: "hang-child", mode: "plan:hang-child" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const childFile = path.join(profilePaths(dataDir, "gemini-b").sessionDir, "children", `${String((await orchestra.status(String(stubborn.id))).attemptId)}.pid`);
  const childPid = fs.existsSync(childFile) ? Number(fs.readFileSync(childFile, "utf8")) : 0;
  const ignored = childPid > 0 && alive(childPid);
  await orchestra.cancel(String(stubborn.id), { wait: true, timeoutMs: 2500 });
  const sigtermIgnoredThenStopped = ignored && !alive(childPid);
  record("child_ignores_sigterm", [await orchestra.status(String(stubborn.id))]);

  const homeB = profilePaths(dataDir, "gemini-b").homeDir;
  const first = await orchestra.delegate({ profile: "gemini-b", goal: "write-bench-marker", mode: "plan:ok", idempotencyKey: "same-job", acceptanceTests: check(homeB) });
  const second = await orchestra.delegate({ profile: "gemini-b", goal: "write-bench-marker", mode: "plan:ok", idempotencyKey: "same-job", acceptanceTests: check(homeB) });
  const doneFirst = await orchestra.wait(String(first.id), 3000);
  const doneSecond = String(second.id) === String(first.id) ? doneFirst : await orchestra.wait(String(second.id), 3000);
  record("duplicate_delegate", String(second.id) === String(first.id) ? [doneFirst] : [doneFirst, doneSecond]);

  const marker = path.join(home, "bench-marker.txt");
  if (fs.existsSync(marker)) fs.appendFileSync(marker, "edited\n");
  const staleId = String(crash.id);
  const stale = await orchestra.status(staleId);
  record("stale_evidence_after_edit", [stale.verification === "verified" ? stale : { ...stale, verification: stale.verification }]);

  await orchestra.reportError("gemini-b", { httpStatus: 403, message: "forbidden" });
  const plain = await orchestra.delegate({ profile: "gemini-b", goal: "write-bench-marker", mode: "plan:ok", acceptanceTests: check(homeB) });
  const plainDone = await orchestra.wait(String(plain.id), 3000);
  record("generic_403_not_rotation", [plainDone]);
  const restrictedDidNotRotate = plainDone.profile === "gemini-b";
  return { rows, earlyRetryBlocked, sigtermIgnoredThenStopped, restrictedDidNotRotate };
}

export async function runFaultSuite(bin: string): Promise<Record<string, unknown>> {
  const script = JSON.parse(fs.readFileSync(scriptPath, "utf8")) as { name: string; cases: string[] };
  const baseline = await pass(bin, false);
  const recovery = await pass(bin, true);
  const missing = script.cases.filter((id) => !baseline.rows.some((row) => row.id === id) || !recovery.rows.some((row) => row.id === id));
  if (missing.length > 0) throw new Error(`fault script skipped: ${missing.join(",")}`);
  const baseLaunched = baseline.rows.reduce((sum, row) => sum + row.launched, 0);
  const baseVerified = baseline.rows.reduce((sum, row) => sum + row.verified, 0);
  const recLaunched = recovery.rows.reduce((sum, row) => sum + row.launched, 0);
  const recVerified = recovery.rows.reduce((sum, row) => sum + row.verified, 0);
  const baseRate = baseLaunched === 0 ? 0 : baseVerified / baseLaunched;
  const recRate = recLaunched === 0 ? 0 : recVerified / recLaunched;
  const ratio = baseRate === 0 ? 0 : Number((recRate / baseRate).toFixed(2));
  const claim2x = baseRate > 0 && ratio >= 2 && missing.length === 0;
  return {
    script: script.name,
    deterministic: true,
    metric: "independently_verified_completions / launched_root_tasks",
    baseline: { verified: baseVerified, launched: baseLaunched, rate: Number(baseRate.toFixed(3)), rows: baseline.rows, recoveryEnabled: false, cancellationEnabled: false, idempotencyEnabled: false },
    recovery: { verified: recVerified, launched: recLaunched, rate: Number(recRate.toFixed(3)), rows: recovery.rows, earlyRetryBlocked: recovery.earlyRetryBlocked, sigtermIgnoredThenStopped: recovery.sigtermIgnoredThenStopped, restrictedDidNotRotate: recovery.restrictedDidNotRotate },
    verifiedRatio: ratio,
    claim2x,
    skipped: missing,
  };
}
