import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { measureCodexOverhead } from "../src/overhead.js";
import { runFaultSuite } from "../src/fault-suite.js";
import { Orchestra } from "../src/service.js";
import { parseHandoffCard } from "../src/validate.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bin = path.join(root, "tools/fake-gemini.sh");
const roots: Orchestra[] = [];

function fresh(): Orchestra {
  const orchestra = new Orchestra(fs.mkdtempSync(path.join(os.tmpdir(), "orch-pool-")));
  roots.push(orchestra);
  return orchestra;
}

test("codex overhead is measured on skill, schema, calls, and results", () => {
  const report = measureCodexOverhead();
  assert.equal(report.tokenizer, "unavailable");
  assert.equal(report.alone.roundTrips, 0);
  assert.equal(report.alone.schemaBytes, 0);
  assert.equal(report.compactFewerSchemaBytes, true);
  assert.equal(report.compactFewerResultBytes, true);
  assert.equal(report.compactFewerRoundTrips, true);
  assert.equal(report.largeOutputsReferencedByPath, true);
  assert.equal(report.verbose.largeOutputInlined, true);
  assert.equal(report.productClaim5x, false);
  assert.ok(report.compact.estimatedTokens < report.verbose.estimatedTokens);
  fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(root, "artifacts/codex-overhead.json"), `${JSON.stringify(report, null, 2)}\n`);
});

test("vendored staging skill stays out of live profiles and names the bound catalog", () => {
  const skill = fs.readFileSync(path.join(root, "orchestration/staging/delegate-and-wait/SKILL.md"), "utf8");
  const binding = fs.readFileSync(path.join(root, "orchestration/staging/CATALOG-BINDING.md"), "utf8");
  const operational = fs.readFileSync(path.join(root, "orchestration/skills-src/codex-compact/SKILL.md"), "utf8");
  assert.equal(skill.trim().split("\n").length, 13);
  assert.match(binding, /delegate_and_wait/);
  assert.match(operational, /delegate_and_wait/);
  assert.match(operational, /status/);
  assert.match(operational, /message/);
  assert.match(operational, /cancel/);
  assert.doesNotMatch(operational, /Poll status/);
  assert.equal(fs.existsSync(path.join(os.homedir(), ".agents/skills/delegate-and-wait/SKILL.md")), false);
  assert.equal(fs.existsSync(path.join(os.homedir(), ".gemini/config/skills/delegate-and-wait/SKILL.md")), false);
});

test("handoff cards match the vendored schema", async () => {
  const orchestra = fresh();
  await orchestra.addProfile({ name: "gemini-a", accountLabel: "sandbox-a", identityClass: "sandbox", role: "delegated", schedulingOptIn: true });
  await orchestra.up("gemini-a");
  const handed = await orchestra.handoff({ profile: "gemini-a", goal: "carry this", constraints: "no spend", doneCheck: "a person checks it" });
  const card = JSON.parse(fs.readFileSync(String(handed.cardPath), "utf8"));
  parseHandoffCard(card);
  assert.equal(card.schema, "handoff-card.v1");
  assert.deepEqual(card.constraints, ["no spend"]);
});

test("fault script measures verified completions against a disabled baseline", async () => {
  const report = await runFaultSuite(bin);
  fs.writeFileSync(path.join(root, "artifacts/fault-reliability.json"), `${JSON.stringify(report, null, 2)}\n`);
  const baseline = report.baseline as { verified: number; launched: number; rate: number };
  const recovered = report.recovery as { verified: number; launched: number; rate: number };
  fs.writeFileSync(path.join(root, "artifacts/fault-reliability.md"), `# Fault reliability\n\nMetric: independently verified completions / launched root tasks.\n\n| | verified | launched | rate |\n| --- | ---: | ---: | ---: |\n| Baseline (recovery, cancellation, and idempotency off) | ${baseline.verified} | ${baseline.launched} | ${baseline.rate} |\n| Recovery on | ${recovered.verified} | ${recovered.launched} | ${recovered.rate} |\n\nVerified ratio: **${String(report.verifiedRatio)}**. Claim of at least 2× on this fake suite: **${String(report.claim2x)}**.\n`);
  const recovery = report.recovery as { earlyRetryBlocked: boolean; sigtermIgnoredThenStopped: boolean; restrictedDidNotRotate: boolean; rows: { id: string }[] };
  assert.equal(recovery.earlyRetryBlocked, true);
  assert.equal(recovery.sigtermIgnoredThenStopped, true);
  assert.equal(recovery.restrictedDidNotRotate, true);
  assert.equal((report.skipped as string[]).length, 0);
  assert.equal(recovery.rows.length, 13);
  assert.equal(report.claim2x, true);
});

test("pacing queues through cooldown and does not rotate to an idle account", async () => {
  const orchestra = fresh();
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
  await orchestra.reportError("gemini-a", { httpStatus: 429, code: "rate_limit", message: "slow down", retryAfterMs: 1200 });
  const burst = await Promise.all([
    orchestra.delegate({ profile: "gemini-a", goal: "one", mode: "plan:ok" }),
    orchestra.delegate({ profile: "gemini-a", goal: "two", mode: "plan:ok" }),
  ]);
  assert.equal(burst[0]?.state, "queued");
  assert.equal(burst[1]?.state, "queued");
  assert.equal(burst[0]?.reason, "cooldown");
  assert.equal(burst[0]?.profile, "gemini-a");
  assert.equal(burst[1]?.profile, "gemini-a");
  const sessionDir = (JSON.parse(fs.readFileSync(path.join(orchestra.dataDir, "state.json"), "utf8")) as { profiles: { name: string; sessionDir: string }[] }).profiles.find((item) => item.name === "gemini-a")!.sessionDir;
  const log = path.join(sessionDir, "gemini-spawns.log");
  assert.equal(fs.existsSync(log), false);
  await orchestra.schedule();
  assert.equal(fs.existsSync(log), false);
  const restarted = new Orchestra(orchestra.dataDir);
  roots.push(restarted);
  const still = await restarted.status(String(burst[0]?.id));
  assert.equal(still.reason, "cooldown");
  assert.equal(still.profile, "gemini-a");
  await orchestra.reportError("gemini-a", { httpStatus: 403, code: "account_suspended", message: "account_suspended" });
  const held = await orchestra.delegate({ profile: "gemini-a", goal: "stay", mode: "plan:ok" });
  assert.equal(held.profile, "gemini-a");
  assert.equal(held.state, "queued");
  assert.notEqual(held.reason, "rotated");
  const idle = await orchestra.delegate({ profile: "gemini-b", goal: "separate explicit job", mode: "plan:ok" });
  assert.equal(idle.profile, "gemini-b");
  const tasks = (restarted.doctor() as { accounts: { name: string }[] }).accounts;
  assert.equal(tasks.length >= 2, true);
  await assert.rejects(() => orchestra.delegate({ profile: "gemini-a", goal: "hide", mode: "spoof-fingerprint" }), /evasion_rejected|hide/);
});

test.after(() => {
  for (const orchestra of roots) {
    for (const profile of orchestra.listProfiles()) {
      const pid = (profile as { workerPid: number | null }).workerPid;
      if (pid) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
      }
    }
  }
});
