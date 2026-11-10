import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Orchestra } from "../src/service.js";

const roots: Orchestra[] = [];

function fresh(): Orchestra {
  const orchestra = new Orchestra(fs.mkdtempSync(path.join(os.tmpdir(), "orch-sch-")));
  roots.push(orchestra);
  return orchestra;
}

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");

after(async () => {
  for (const orchestra of roots) {
    for (const profile of orchestra.listProfiles() as { name: string }[]) {
      await orchestra.down(profile.name).catch(() => undefined);
    }
  }
});

async function sandbox(orchestra: Orchestra, name: string, envName: string): Promise<void> {
  process.env[envName] = `synthetic-${name}-value-99`;
  await orchestra.addProfile({
    name,
    accountLabel: name,
    identityClass: "sandbox",
    role: "delegated",
    schedulingOptIn: true,
    credentialEnvVar: envName,
  });
  await orchestra.up(name);
}

test("one scheduler enforces a provider-wide concurrency ceiling", async () => {
  const orchestra = fresh();
  await orchestra.setCeiling(1);
  await sandbox(orchestra, "gemini-a", "GEMINI_SYNTH_A");
  await sandbox(orchestra, "gemini-b", "GEMINI_SYNTH_B");
  const first = await orchestra.delegate({ profile: "gemini-a", goal: "hold", mode: "hang-child" });
  const second = await orchestra.delegate({ profile: "gemini-b", goal: "wait" });
  assert.equal(second.state, "queued");
  assert.equal(second.reason, "provider_ceiling");
  const profileB = (orchestra.listProfiles() as { name: string; id: string }[]).find((profile) => profile.name === "gemini-b")!;
  assert.equal(fs.existsSync(path.join(orchestra.dataDir, "profiles", profileB.id, "session", "inbox")), true);
  const queuedInbox = fs.readdirSync(path.join(orchestra.dataDir, "profiles", profileB.id, "session", "inbox"));
  assert.equal(queuedInbox.length, 0);
  await orchestra.status(String(second.id));
  assert.equal(fs.readdirSync(path.join(orchestra.dataDir, "profiles", profileB.id, "session", "inbox")).length, 0);
  const cancelled = await orchestra.cancel(String(first.id), { wait: true, timeoutMs: 3000 });
  assert.equal(cancelled.code, 0);
  assert.equal(cancelled.state, "cancelled");
  const done = await orchestra.wait(String(second.id), 4000);
  assert.equal(done.state, "completed_unverified");
  assert.equal(done.profile, "gemini-b");
});

test("cancel rejects a late success and can time out while a child ignores SIGTERM", async () => {
  const orchestra = fresh();
  await orchestra.setGrace(5000);
  await sandbox(orchestra, "gemini-a", "GEMINI_SYNTH_A");
  const hanging = await orchestra.delegate({ profile: "gemini-a", goal: "child", mode: "hang-child" });
  const childFile = path.join(orchestra.dataDir, "profiles", (hanging.profileId as string), "session", "child.pid");
  const appeared = Date.now();
  while (!fs.existsSync(childFile) && Date.now() - appeared < 3000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const childPid = Number(fs.readFileSync(childFile, "utf8"));
  const incomplete = await orchestra.cancel(String(hanging.id), { wait: true, timeoutMs: 200 });
  assert.equal(incomplete.code, 2);
  assert.equal(incomplete.quiescent, false);
  assert.equal(alive(childPid), true);
  const done = await orchestra.cancel(String(hanging.id), { wait: true, timeoutMs: 8000 });
  assert.equal(done.code, 0);
  assert.equal(done.state, "cancelled");
  assert.equal(alive(childPid), false);

  const late = await orchestra.delegate({ profile: "gemini-a", goal: "late", mode: "late-ok" });
  const lateResult = await orchestra.cancel(String(late.id), { wait: true, timeoutMs: 3000 });
  assert.equal(lateResult.state, "cancelled");
  const viewed = await orchestra.status(String(late.id));
  assert.equal(viewed.lateResultRejected, true);
  assert.notEqual(viewed.state, "completed_unverified");
});

test("generic 403 does not open the provider circuit; explicit events do", async () => {
  const orchestra = fresh();
  await sandbox(orchestra, "gemini-a", "GEMINI_SYNTH_A");
  await sandbox(orchestra, "gemini-b", "GEMINI_SYNTH_B");
  await orchestra.addProfile({
    name: "gemini-c",
    accountLabel: "sandbox-c",
    identityClass: "sandbox",
    role: "delegated",
    schedulingOptIn: true,
  });
  await orchestra.up("gemini-c");
  await orchestra.reportError("gemini-a", { httpStatus: 403, message: "forbidden" });
  await orchestra.reportError("gemini-b", { httpStatus: 403, message: "forbidden" });
  const stillOpen = orchestra.doctor() as { limiter: { paused: boolean } };
  assert.equal(stillOpen.limiter.paused, false);
  const health = orchestra.listProfiles().find((profile) => (profile as { name: string }).name === "gemini-a") as {
    health: { state: string; lastError: { generic403IsSuspension: boolean; evidenceAt: string } };
  };
  assert.equal(health.health.state, "unknown");
  assert.equal(health.health.lastError.generic403IsSuspension, false);
  assert.ok(health.health.lastError.evidenceAt);
  await orchestra.reportError("gemini-a", { httpStatus: 403, code: "account_suspended", message: "account_suspended" });
  await orchestra.reportError("gemini-b", { httpStatus: 401, code: "invalid_api_key", message: "auth failed" });
  assert.equal((orchestra.doctor() as { limiter: { paused: boolean } }).limiter.paused, true);
  const held = await orchestra.delegate({ profile: "gemini-c", goal: "blocked" });
  assert.equal(held.state, "queued");
  assert.equal(held.reason, "provider_circuit_open");
  assert.equal(held.profile, "gemini-c");
  const recovered = await orchestra.providerRecover();
  assert.equal(recovered.providerUnbanClaimed, false);
  const task = await orchestra.delegate({ profile: "gemini-c", goal: "after local recovery" });
  const done = await orchestra.wait(String(task.id), 4000);
  assert.equal(done.state, "completed_unverified");
  await assert.rejects(
    () => orchestra.delegate({ profile: "gemini-c", goal: "rotate", fallbackProfile: "gemini-a" }),
    /Google identities|Paid|ineligible|circuit/,
  );
});

test("personal identities and API fallback are refused for experiments", async () => {
  const orchestra = fresh();
  await orchestra.addProfile({
    name: "main",
    accountLabel: "personal",
    identityClass: "personal",
    role: "main",
    schedulingOptIn: true,
  });
  await orchestra.up("main");
  await assert.rejects(() => orchestra.delegate({ profile: "main", goal: "experiment", experiment: true }), /personal/);
  await orchestra.addProfile({
    name: "api",
    accountLabel: "optional-api",
    identityClass: "sandbox",
    role: "delegated",
    schedulingOptIn: true,
    authMode: "api_key",
    apiOptIn: true,
  });
  await assert.rejects(() => orchestra.delegate({ profile: "main", goal: "pay", fallbackProfile: "api" }), /Paid/);
});

test("restart adopts the same worker and does not spawn another", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-crash-"));
  const env = { ...process.env, GEMINI_SYNTH_A: "synthetic-crash-account-77" };
  const added = spawnSync(
    process.execPath,
    [cli, "--data", dataDir, "profile-add", "--name", "gemini-a", "--account", "sandbox-a", "--identity", "sandbox", "--role", "delegated", "--opt-in", "--credential-env", "GEMINI_SYNTH_A"],
    { env, encoding: "utf8" },
  );
  assert.equal(added.status, 0, added.stdout + added.stderr);
  const crashed = spawnSync(process.execPath, [cli, "--data", dataDir, "up", "--name", "gemini-a"], {
    env: { ...env, ORCHESTRA_CRASH_AT: "after_worker_pid" },
    encoding: "utf8",
  });
  assert.equal(crashed.status, 99, crashed.stdout + crashed.stderr);
  const profile = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8")).profiles[0] as { sessionDir: string; workerPid: number };
  const starts = fs.readFileSync(path.join(profile.sessionDir, "starts.log"), "utf8").trim().split("\n");
  assert.equal(starts.length, 1);
  const reconciled = spawnSync(process.execPath, [cli, "--data", dataDir, "reconcile"], { env, encoding: "utf8" });
  assert.equal(reconciled.status, 0, reconciled.stdout);
  assert.equal(fs.readFileSync(path.join(profile.sessionDir, "starts.log"), "utf8").trim().split("\n").length, 1);
  const again = spawnSync(process.execPath, [cli, "--data", dataDir, "up", "--name", "gemini-a"], { env, encoding: "utf8" });
  assert.equal(again.status, 0, again.stdout);
  assert.equal(JSON.parse(again.stdout).spawned, false);
  assert.equal(fs.readFileSync(path.join(profile.sessionDir, "starts.log"), "utf8").trim().split("\n").length, 1);
  process.kill(profile.workerPid, "SIGKILL");
});

test("retry-after cooldown is visible to a restarted scheduler", async () => {
  const orchestra = fresh();
  await sandbox(orchestra, "gemini-a", "GEMINI_SYNTH_A");
  await orchestra.reportError("gemini-a", { httpStatus: 429, code: "rate_limit", message: "slow down", retryAfterMs: 60_000 });
  const restarted = new Orchestra(orchestra.dataDir);
  roots.push(restarted);
  const held = await Promise.all([restarted.delegate({ profile: "gemini-a", goal: "one" }), restarted.delegate({ profile: "gemini-a", goal: "two" })]);
  assert.equal(held[0]?.state, "queued");
  assert.equal(held[1]?.state, "queued");
  assert.equal(held[0]?.reason, "cooldown");
  assert.equal(held[1]?.profile, "gemini-a");
});

test("benchmark labels stay short of a 5x or learned-routing claim", async () => {
  const orchestra = fresh();
  await sandbox(orchestra, "gemini-a", "GEMINI_SYNTH_A");
  await sandbox(orchestra, "gemini-b", "GEMINI_SYNTH_B");
  const report = (await orchestra.benchmark()) as {
    targetSpeedup: number;
    targetIsMeasuredClaim: boolean;
    learnedRoutingImplemented: boolean;
    liveGoogleAuthVerified: boolean;
    mocksAreProviderEvidence: boolean;
  };
  assert.equal(report.targetSpeedup, 5);
  assert.equal(report.targetIsMeasuredClaim, false);
  assert.equal(report.learnedRoutingImplemented, false);
  assert.equal(report.liveGoogleAuthVerified, false);
  assert.equal(report.mocksAreProviderEvidence, false);
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
