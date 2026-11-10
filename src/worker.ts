#!/usr/bin/env node
/**
 * Persistent per-account isolation worker.
 *
 * This is the process the scheduler launches for a Gemini CLI profile in this
 * environment. It is not the Gemini CLI and it does not contact Google.
 * It enforces profile id, session ownership, and config-dir checks.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sessionDir = required("ORCHESTRA_SESSION_DIR");
const configDir = required("ORCHESTRA_CONFIG_DIR");
const profileId = required("ORCHESTRA_PROFILE_ID");

const inbox = path.join(sessionDir, "inbox");
const outbox = path.join(sessionDir, "outbox");
const cancelDir = path.join(sessionDir, "cancel");
fs.mkdirSync(inbox, { recursive: true });
fs.mkdirSync(outbox, { recursive: true });
fs.mkdirSync(cancelDir, { recursive: true });

fs.appendFileSync(path.join(sessionDir, "starts.log"), `${process.pid}\n`);
fs.writeFileSync(
  path.join(sessionDir, "worker.json"),
  JSON.stringify({ pid: process.pid, profileId, startedAt: Date.now() }),
);

process.on("SIGHUP", () => undefined);

const busy = new Set<string>();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`missing ${name}\n`);
    process.exit(1);
  }
  return value;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function atomicWrite(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function sessions(): Record<string, { profileId: string }> {
  const file = path.join(sessionDir, "sessions.json");
  if (!fs.existsSync(file)) return {};
  return readJson(file) as Record<string, { profileId: string }>;
}

function saveSessions(value: Record<string, { profileId: string }>): void {
  atomicWrite(path.join(sessionDir, "sessions.json"), value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function configProfile(): string {
  const marker = path.join(configDir, "profile.json");
  if (!fs.existsSync(marker)) throw new Error("profile_config_missing");
  const parsed = readJson(marker);
  if (parsed.profileId !== profileId) throw new Error("config_boundary");
  return String(parsed.profileId);
}

async function killChild(pid: number): Promise<void> {
  const grace = Number(process.env.ORCHESTRA_GRACE_MS ?? "200");
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  await sleep(grace);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function handle(file: string): Promise<void> {
  const base = path.basename(file);
  if (busy.has(base)) return;
  busy.add(base);
  let req: Record<string, unknown>;
  try {
    req = readJson(file);
  } catch {
    busy.delete(base);
    return;
  }
  const attemptId = String(req.attemptId ?? "");
  const finish = (body: Record<string, unknown>) => {
    atomicWrite(path.join(outbox, `${attemptId}.json`), {
      attemptId,
      ownerGeneration: req.ownerGeneration ?? null,
      profileId,
      ...body,
    });
    if (fs.existsSync(file)) fs.unlinkSync(file);
    busy.delete(base);
  };
  try {
    if (req.profileId !== profileId) {
      finish({ ok: false, error: "profile_mismatch" });
      return;
    }
    const configId = configProfile();
    const all = sessions();
    let sessionId = typeof req.sessionId === "string" ? req.sessionId : "";
    if (sessionId) {
      const known = all[sessionId];
      if (!known || known.profileId !== profileId) {
        finish({ ok: false, error: "session_crossover_rejected", sessionId });
        return;
      }
    } else {
      sessionId = randomUUID();
      all[sessionId] = { profileId };
      saveSessions(all);
    }
    if (req.mode !== "late-ok" && fs.existsSync(path.join(cancelDir, attemptId))) {
      finish({ ok: false, error: "cancelled", sessionId });
      return;
    }
    if (req.mode === "hang-child") {
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},400);"], {
        detached: true,
        stdio: "ignore",
      });
      if (child.pid) {
        fs.writeFileSync(path.join(sessionDir, "child.pid"), String(child.pid));
        child.unref();
      }
      const cancelPath = path.join(cancelDir, attemptId);
      while (!fs.existsSync(cancelPath) && !fs.existsSync(path.join(sessionDir, "shutdown"))) {
        await sleep(30);
      }
      if (child.pid) await killChild(child.pid);
      finish({ ok: false, error: "cancelled", sessionId });
      return;
    }
    if (req.mode === "slow") await sleep(Number(req.slowMs ?? 120));
    if (req.mode === "secret") {
      const envName = process.env.ORCHESTRA_CREDENTIAL_ENV ?? "";
      const value = envName ? process.env[envName] ?? "" : "";
      fs.appendFileSync(path.join(sessionDir, "stderr.log"), `worker stderr ${value}\n`);
    }
    if (req.mode === "bad-owner") {
      finish({ ok: true, sessionId, ownerGeneration: "stale-owner", summary: "ignored" });
      return;
    }
    const other = typeof req.otherEnvName === "string" ? req.otherEnvName : "";
    const own = process.env.ORCHESTRA_CREDENTIAL_ENV ?? "";
    const boundary = {
      profileId: configId,
      home: process.env.HOME ?? null,
      geminiCliHome: process.env.GEMINI_CLI_HOME ?? null,
      hasOwnCredential: Boolean(own && process.env[own]),
      hasOther: Boolean(other && process.env[other]),
      hasApiKey: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
      hasAdc: Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS),
      hasCanary: Boolean(process.env.LEAK_CANARY),
      sessionId,
    };
    atomicWrite(path.join(sessionDir, "boundary.json"), boundary);
    if (req.mode === "late-ok") {
      await sleep(300);
      finish({ ok: true, sessionId, summary: "late", boundary });
      return;
    }
    finish({ ok: true, sessionId, summary: `turn for ${profileId}`, boundary });
  } catch (error) {
    finish({ ok: false, error: error instanceof Error ? error.message : "worker_error" });
  }
}

async function scan(): Promise<void> {
  if (fs.existsSync(path.join(sessionDir, "shutdown"))) {
    const childFile = path.join(sessionDir, "child.pid");
    if (fs.existsSync(childFile)) {
      const pid = Number(fs.readFileSync(childFile, "utf8"));
      if (Number.isFinite(pid)) await killChild(pid);
    }
    process.exit(0);
  }
  const files = fs.readdirSync(inbox).filter((name) => name.endsWith(".json"));
  for (const name of files) await handle(path.join(inbox, name));
}

setInterval(() => {
  void scan();
}, 30);
try {
  fs.watch(inbox, () => {
    void scan();
  });
} catch {
  /* interval remains */
}
void scan();
