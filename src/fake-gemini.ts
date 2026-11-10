#!/usr/bin/env node
/**
 * LABELED LOCAL FAKE. This is not the Gemini CLI and it does not contact Google.
 * It speaks the stream-json subset the process adapter parses, so protocol tests
 * can launch a real executable without a login or a paid API.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
if (argv.includes("--yolo") || argv.includes("--dangerously-skip-permissions")) {
  process.stderr.write("permission bypass refused\n");
  process.exit(2);
}

function option(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const goal = option("-p") ?? option("--prompt") ?? "";
const format = option("--output-format");
const resume = option("--resume");
if (format !== "stream-json") {
  process.stderr.write("stream-json is required\n");
  process.exit(2);
}
if (resume === "latest" || (resume !== undefined && !/^[0-9a-f-]{36}$/i.test(resume))) {
  process.stderr.write("resume requires an explicit uuid\n");
  process.exit(2);
}

const home = process.env.GEMINI_CLI_HOME || process.cwd();
fs.mkdirSync(home, { recursive: true });
const registryPath = path.join(home, "fake-sessions.json");
const registry = fs.existsSync(registryPath)
  ? (JSON.parse(fs.readFileSync(registryPath, "utf8")) as Record<string, { profileId: string | null }>)
  : {};
const profileId = process.env.ORCHESTRA_PROFILE_ID ?? null;

if (process.env.ORCHESTRA_SPAWN_LOG) {
  fs.appendFileSync(process.env.ORCHESTRA_SPAWN_LOG, `${process.pid}\n`);
}
if (process.env.ORCHESTRA_ARGV_LOG) {
  fs.appendFileSync(process.env.ORCHESTRA_ARGV_LOG, `${JSON.stringify(argv)}\n`);
}

function emit(body: Record<string, unknown>): void {
  const line = `${JSON.stringify(body)}\n`;
  process.stdout.write(line);
  if (process.env.ORCHESTRA_STREAM_PATH) {
    fs.mkdirSync(path.dirname(process.env.ORCHESTRA_STREAM_PATH), { recursive: true });
    fs.appendFileSync(process.env.ORCHESTRA_STREAM_PATH, line);
  }
}

if (resume && (!registry[resume] || registry[resume].profileId !== profileId)) {
  emit({ event: "result", status: "error", session_id: resume, response: "", error: "session_not_owned" });
  process.exit(1);
}

const sessionId = resume ?? randomUUID();
registry[sessionId] = { profileId };
fs.writeFileSync(registryPath, JSON.stringify(registry));
emit({ event: "init", session_id: sessionId, model: "fake-not-gemini", fake: true });

const plan = process.env.FAKE_PLAN;
const counterPath = process.env.FAKE_COUNTER;
let step = "ok";
if (plan && counterPath) {
  const seen = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf8")) || 0 : 0;
  fs.writeFileSync(counterPath, String(seen + 1));
  const steps = plan.split(",").filter(Boolean);
  step = steps[Math.min(seen, steps.length - 1)] ?? "ok";
}
if (step === "crash") process.exit(1);
if (step === "badjson") {
  const junk = "NOT_JSON\n";
  process.stdout.write(junk);
  if (process.env.ORCHESTRA_STREAM_PATH) fs.appendFileSync(process.env.ORCHESTRA_STREAM_PATH, junk);
  process.exit(1);
}
if (step === "slow") {
  const end = Date.now() + 200;
  while (Date.now() < end) undefined;
}
if (step === "429") {
  emit({
    event: "result",
    status: "error",
    session_id: sessionId,
    response: "",
    error: "rate_limit",
    retry_after_ms: 200,
    lease: process.env.ORCHESTRA_LEASE ?? null,
    fake: true,
  });
  process.exit(1);
}
if (goal.includes("hang-child") || step === "hang" || step === "hang-child") {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},400);"], {
    stdio: "ignore",
  });
  if (child.pid && process.env.ORCHESTRA_CHILD_PID_FILE) {
    fs.writeFileSync(process.env.ORCHESTRA_CHILD_PID_FILE, String(child.pid));
  }
  setInterval(() => undefined, 1000);
} else {
  if (goal.includes("write-marker")) fs.writeFileSync(path.join(process.cwd(), "marker.txt"), "marked\n");
  if (goal.includes("write-bench-marker")) {
    fs.writeFileSync(path.join(process.cwd(), "bench-marker.txt"), `marked ${process.env.FAKE_NONCE ?? ""}\n`);
  }
  if (goal.includes("slow")) {
    const end = Date.now() + 80;
    while (Date.now() < end) undefined;
  }
  emit({
    event: "message",
    role: "assistant",
    text: `fake response for ${profileId ?? "profile"}`,
  });
  emit({
    event: "result",
    status: "success",
    session_id: sessionId,
    response: `fake response for ${profileId ?? "profile"}`,
    stats: { input_tokens: null, output_tokens: null },
    lease: process.env.ORCHESTRA_LEASE ?? null,
    fake: true,
  });
  process.exit(0);
}
