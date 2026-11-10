import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { geminiSubscriptionArgv, antigravitySubscriptionArgv } from "../src/launch.js";
import { Orchestra, OrchestraError } from "../src/service.js";

const SENTINEL_A = "synthetic-gemini-a-7f3c9a";
const SENTINEL_B = "synthetic-gemini-b-1c8e44";
const roots: string[] = [];
const live: Orchestra[] = [];

function fresh(): Orchestra {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-"));
  roots.push(dir);
  const orchestra = new Orchestra(dir);
  live.push(orchestra);
  return orchestra;
}

after(async () => {
  for (const orchestra of live) {
    for (const name of ["gemini-a", "gemini-b", "gemini-c"]) {
      const profiles = orchestra.listProfiles() as { name?: string }[];
      if (profiles.some((profile) => profile.name === name)) {
        await orchestra.down(name).catch(() => undefined);
      }
    }
  }
});

async function twoAccounts(orchestra: Orchestra): Promise<void> {
  process.env.GEMINI_SYNTH_A = SENTINEL_A;
  process.env.GEMINI_SYNTH_B = SENTINEL_B;
  process.env.GEMINI_API_KEY = "paid-key-should-not-pass";
  process.env.LEAK_CANARY = "canary-should-not-pass";
  for (const [name, envName, label] of [
    ["gemini-a", "GEMINI_SYNTH_A", "sandbox-a"],
    ["gemini-b", "GEMINI_SYNTH_B", "sandbox-b"],
  ] as const) {
    await orchestra.addProfile({
      name,
      agent: "gemini-cli",
      accountLabel: label,
      identityClass: "sandbox",
      role: "delegated",
      schedulingOptIn: true,
      credentialEnvVar: envName,
    });
    await orchestra.up(name);
  }
}

test("launch plans keep Gemini CLI and Antigravity apart and omit API keys", () => {
  const gemini = geminiSubscriptionArgv("hello", "123e4567-e89b-12d3-a456-426614174000");
  assert.deepEqual(gemini.slice(0, 4), ["gemini", "-p", "hello", "--output-format"]);
  assert.ok(gemini.includes("--resume"));
  assert.equal(gemini.includes("--yolo"), false);
  assert.throws(() => geminiSubscriptionArgv("hello", "latest"), /gemini_resume_requires_uuid/);
  const agy = antigravitySubscriptionArgv("hello", "055a398f-db14-4c5f-abbb-1bf03f8120a7");
  assert.equal(agy[0], "agy");
  assert.ok(agy.includes("--conversation"));
  assert.equal(agy.includes("--resume"), false);
  assert.equal(agy.includes("--dangerously-skip-permissions"), false);
});

test("two Gemini CLI profiles run concurrently with pinned sessions and no crossover", async () => {
  const orchestra = fresh();
  await twoAccounts(orchestra);
  const [first, second] = await Promise.all([
    orchestra.delegate({ profile: "gemini-a", goal: "turn A", otherEnvName: "GEMINI_SYNTH_B" }),
    orchestra.delegate({ profile: "gemini-b", goal: "turn B", otherEnvName: "GEMINI_SYNTH_A" }),
  ]);
  const doneA = await orchestra.wait(String(first.id), 4000);
  const doneB = await orchestra.wait(String(second.id), 4000);
  assert.equal(doneA.state, "completed_unverified");
  assert.equal(doneB.state, "completed_unverified");
  assert.equal(doneA.liveGoogleAuthVerified, false);
  assert.notEqual(doneA.sessionId, doneB.sessionId);
  assert.equal(doneA.profile, "gemini-a");
  assert.equal(doneB.profile, "gemini-b");
  const boundaryA = doneA.result as { boundary: Record<string, unknown> };
  const boundaryB = doneB.result as { boundary: Record<string, unknown> };
  assert.equal(boundaryA.boundary.hasOwnCredential, true);
  assert.equal(boundaryA.boundary.hasOther, false);
  assert.equal(boundaryA.boundary.hasApiKey, false);
  assert.equal(boundaryA.boundary.hasCanary, false);
  assert.equal(boundaryB.boundary.hasOther, false);
  assert.equal(boundaryB.boundary.hasApiKey, false);
  assert.notEqual(boundaryA.boundary.home, boundaryB.boundary.home);

  const resumed = await orchestra.resume(String(first.id));
  const again = await orchestra.wait(String(resumed.id), 4000);
  assert.equal(again.sessionId, doneA.sessionId);
  assert.equal(again.profile, "gemini-a");
  await assert.rejects(() => orchestra.resume(String(first.id), { profile: "gemini-b" }), /pinned account/);

  const profiles = orchestra.listProfiles() as { id: string; name: string; sessionId: string }[];
  const profileA = profiles.find((profile) => profile.name === "gemini-a")!;
  const profileB = profiles.find((profile) => profile.name === "gemini-b")!;
  const dbDir = (orchestra as unknown as { dataDir: string }).dataDir;
  const sessionB = path.join(dbDir, "profiles", profileB.id, "session");
  const attempt = `att_foreign`;
  fs.writeFileSync(
    path.join(sessionB, "inbox", `${attempt}.json`),
    JSON.stringify({
      attemptId: attempt,
      ownerGeneration: "x",
      profileId: profileB.id,
      sessionId: doneA.sessionId,
      goal: "steal",
      mode: "ok",
    }),
  );
  const out = path.join(sessionB, "outbox", `${attempt}.json`);
  const started = Date.now();
  while (!fs.existsSync(out) && Date.now() - started < 3000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const body = JSON.parse(fs.readFileSync(out, "utf8")) as { error?: string };
  assert.equal(body.error, "session_crossover_rejected");
  const sessionsA = fs.readFileSync(path.join(dbDir, "profiles", profileA.id, "session", "sessions.json"), "utf8");
  const sessionsB = fs.readFileSync(path.join(sessionB, "sessions.json"), "utf8");
  assert.match(sessionsA, new RegExp(String(doneA.sessionId)));
  assert.equal(sessionsB.includes(String(doneA.sessionId)), false);

  const pid = Number(JSON.parse(fs.readFileSync(path.join(sessionB, "worker.json"), "utf8")).pid);
  const environ = fs.readFileSync(`/proc/${pid}/environ`).toString("utf8").split("\0");
  assert.equal(environ.some((item) => item.includes(SENTINEL_A)), false);
  assert.equal(environ.some((item) => item.startsWith("GEMINI_API_KEY=")), false);
  assert.equal(environ.some((item) => item.startsWith("LEAK_CANARY=")), false);
  assert.ok(environ.some((item) => item.startsWith(`GEMINI_SYNTH_B=${SENTINEL_B}`)));
  fs.mkdirSync("/workspace/artifacts", { recursive: true });
  fs.writeFileSync(
    "/workspace/artifacts/demo-two-gemini.json",
    JSON.stringify(
      {
        liveGoogleAuthVerified: false,
        paidApiUsed: false,
        agent: "gemini-cli",
        sessionA: doneA.sessionId,
        sessionB: doneB.sessionId,
        resumeA: again.sessionId,
        distinctSessions: doneA.sessionId !== doneB.sessionId,
        boundaryA: boundaryA.boundary,
        boundaryB: boundaryB.boundary,
      },
      null,
      2,
    ),
  );
});

test("missing config and symlink escape fail closed", async () => {
  const orchestra = fresh();
  process.env.GEMINI_SYNTH_A = SENTINEL_A;
  await orchestra.addProfile({
    name: "gemini-a",
    accountLabel: "sandbox-a",
    identityClass: "sandbox",
    role: "delegated",
    schedulingOptIn: true,
    credentialEnvVar: "GEMINI_SYNTH_A",
  });
  const listed = orchestra.listProfiles()[0] as { id: string };
  const configDir = path.join((orchestra as unknown as { dataDir: string }).dataDir, "profiles", listed.id, "config");
  fs.rmSync(configDir, { recursive: true });
  await assert.rejects(() => orchestra.up("gemini-a"), /config directory is missing/);
  fs.mkdirSync(path.dirname(configDir), { recursive: true });
  fs.symlinkSync("/tmp", configDir);
  await assert.rejects(() => orchestra.up("gemini-a"), /escapes/);
});

test("secret stderr is redacted and API auth stays optional", async () => {
  const orchestra = fresh();
  await twoAccounts(orchestra);
  const task = await orchestra.delegate({ profile: "gemini-a", goal: "secret", mode: "secret" });
  const done = await orchestra.wait(String(task.id), 4000);
  assert.equal(done.state, "completed_unverified");
  const dataDir = orchestra.dataDir;
  const raw = fs.readFileSync(path.join(dataDir, "state.json"), "utf8");
  const stderr = fs.readFileSync(path.join(dataDir, "profiles", (done.profileId as string), "session", "stderr.log"), "utf8");
  assert.equal(raw.includes(SENTINEL_A), false);
  assert.equal(stderr.includes(SENTINEL_A), false);
  assert.match(stderr, /\[REDACTED\]/);
  await assert.rejects(
    () =>
      orchestra.addProfile({
        name: "paid",
        accountLabel: "paid",
        identityClass: "sandbox",
        role: "delegated",
        authMode: "api_key",
        credentialEnvVar: "GEMINI_API_KEY",
      }),
    /API key auth is optional/,
  );
});

test("doctor and list output do not claim live Google auth or print secrets", async () => {
  const orchestra = fresh();
  await twoAccounts(orchestra);
  const doctor = orchestra.doctor() as {
    liveGoogleAuthVerified: boolean;
    agents: { geminiCli: { binary: string }; antigravity: { equivalentToGeminiCli: boolean; binary: string } };
    paidApiFallback: boolean;
  };
  assert.equal(doctor.liveGoogleAuthVerified, false);
  assert.equal(doctor.agents.geminiCli.binary, "gemini");
  assert.equal(doctor.agents.antigravity.binary, "agy");
  assert.equal(doctor.agents.antigravity.equivalentToGeminiCli, false);
  assert.equal(doctor.paidApiFallback, false);
  const listed = JSON.stringify(orchestra.listProfiles());
  assert.equal(listed.includes(SENTINEL_A), false);
  assert.equal(listed.includes(SENTINEL_B), false);
  const plan = orchestra.launchConfig("gemini-a");
  assert.equal(plan.documentedArgv[0], "gemini");
  assert.equal(plan.auth.apiEnvPassed, false);
  assert.equal(plan.liveGoogleAuthVerified, false);
});

test("MCP delegate and status share the scheduler state", async () => {
  const orchestra = fresh();
  await twoAccounts(orchestra);
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");
  const dataDir = (orchestra as unknown as { dataDir: string }).dataDir;
  const child = spawn(process.execPath, [cli, "--data", dataDir, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  child.stdout.setEncoding("utf8");
  let buffer = "";
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) if (part.trim()) lines.push(part);
  });
  const send = (id: number, method: string, params?: unknown) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  };
  send(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  send(2, "tools/list");
  send(3, "tools/call", { name: "delegate", arguments: { profile: "gemini-a", goal: "from mcp" } });
  const started = Date.now();
  while (lines.length < 3 && Date.now() - started < 4000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const delegated = lines.map((line) => JSON.parse(line) as { id?: number; result?: { content?: { text: string }[] } }).find((message) => message.id === 3);
  assert.ok(delegated?.result?.content?.[0]?.text);
  const body = JSON.parse(delegated.result.content[0].text) as { id: string };
  const viewed = await orchestra.status(body.id);
  assert.equal(viewed.profile, "gemini-a");
  child.kill("SIGTERM");
});
