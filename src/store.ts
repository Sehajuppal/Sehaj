import fs from "node:fs";
import path from "node:path";

export interface Health {
  state: "ok" | "rate_limited" | "quota_exhausted" | "auth_failure" | "provider_suspension" | "provider_ban" | "unknown";
  eligible: boolean;
  pausedUntil: number | null;
  quarantine: boolean;
  disabled: boolean;
  providerUnbanClaimed: false;
  lastError: {
    state: Health["state"];
    httpStatus: number | null;
    sanitizedMessage: string;
    retryAfterMs: number | null;
    evidenceAt: string;
    generic403IsSuspension: false;
  } | null;
}

export interface Profile {
  id: string;
  name: string;
  provider: "gemini";
  agent: "gemini-cli" | "antigravity";
  model: string | null;
  accountLabel: string;
  role: "main" | "delegated";
  identityClass: "personal" | "sandbox";
  schedulingOptIn: boolean;
  authMode: "subscription" | "api_key";
  apiOptIn: boolean;
  credentialEnvVar: string | null;
  homeDir: string;
  geminiCliHome: string;
  configDir: string;
  sessionDir: string;
  workerPid: number | null;
  sessionId: string | null;
  execution: "isolation-worker" | "gemini-process";
  geminiBin: string | null;
  bucketTokens: number;
  bucketAt: number;
  dayKey: string;
  dayCount: number;
  launchCount: number;
  lastLaunchAt: number;
  health: Health;
}

export interface Task {
  id: string;
  profileId: string;
  profileName: string;
  agent: Profile["agent"];
  goal: string;
  state: "queued" | "running" | "cancelling" | "retry_wait" | "waiting_on_human" | "completed_unverified" | "verified" | "blocked" | "failed" | "cancelled" | "needs_reconcile";
  reason: string | null;
  attemptId: string | null;
  sessionId: string | null;
  ownerGeneration: string | null;
  idempotencyKey: string | null;
  payloadHash: string;
  experiment: boolean;
  mode: string;
  otherEnvName: string | null;
  cancelRequested: boolean;
  lateResultRejected: boolean;
  checkpoint: { profileId: string; sessionId: string | null; portable: false } | null;
  result: { summary: string; sessionId: string | null; boundary: Record<string, unknown> | null } | null;
  createdAt: string;
  updatedAt: string;
  kind: "turn" | "supervisor";
  parentId: string | null;
  rootId: string | null;
  poolId: string | null;
  depthRemaining: number;
  permissions: string[];
  dependsOn: string[];
  pid: number | null;
  argv: string[];
  execution: Profile["execution"];
  verification: "none" | "completed_unverified" | "verified";
  check: string | null;
  plumbingCheck: string | null;
  acceptanceTests: { id: string; argv: string[]; required: boolean }[];
  baseDigest: string | null;
  baseCommit: string | null;
  wallTimeSec: number | null;
  evidence: {
    attemptId: string;
    baseDigest: string;
    baseCommit: string | null;
    postDigest: string;
    postCommit: string | null;
    checks: { id: string; exitCode: number; stdoutSha256: string }[];
  } | null;
  messages: { requestId: string; received: true; applied: false; restarted: false }[];
  leaseToken: string | null;
  leaseEpoch: number;
  retries: number;
  notBefore: number | null;
  handoffPath: string | null;
  handoffDeadline: number | null;
}

export interface Pool {
  id: string;
  rootTaskId: string;
  maxConcurrent: number;
  maxTasks: number;
  tasksCreated: number;
  running: number;
  permissions: string[];
  maxDepth: number;
  deadlineAt: number;
}

export interface Limiter {
  provider: "gemini";
  threshold: number;
  paused: boolean;
  explicitEvents: { profileId: string; state: string; at: string }[];
  recovery: "explicit_only";
  providerUnbanClaimed: false;
}

export interface AppEvent {
  seq: number;
  at: string;
  type: string;
  taskId: string | null;
  data: Record<string, unknown>;
}

export interface Db {
  version: 1;
  generation: string;
  settings: {
    graceMs: number;
    providerCeiling: number;
    fallbackAllowlist: { fromProfile: string; toProfile: string }[];
    spendAuthorization: false;
    paidApiFallback: false;
    learnedRouting: false;
    poolEnabled: boolean;
    stallMs: number;
    maxRetries: number;
    recoveryEnabled: boolean;
    cancellationEnabled: boolean;
    idempotencyEnabled: boolean;
    deterministicBackoff: boolean;
    crashNext: "after_enqueue" | "after_spawn" | null;
    pacing: {
      perMinute: number;
      dailyCeiling: number;
      quietHours: { startHour: number; endHour: number } | null;
      rampFirst: number;
      rampGapMs: number;
    };
  };
  profiles: Profile[];
  tasks: Task[];
  events: AppEvent[];
  limiter: Limiter;
  pools: Pool[];
  nextEvent: number;
}

export function emptyDb(generation: string): Db {
  return {
    version: 1,
    generation,
    settings: {
      graceMs: 200,
      providerCeiling: 4,
      fallbackAllowlist: [],
      spendAuthorization: false,
      paidApiFallback: false,
      learnedRouting: false,
      poolEnabled: true,
      stallMs: 60_000,
      maxRetries: 2,
      recoveryEnabled: true,
      cancellationEnabled: true,
      idempotencyEnabled: true,
      deterministicBackoff: false,
      crashNext: null,
      pacing: { perMinute: 600, dailyCeiling: 100_000, quietHours: null, rampFirst: 0, rampGapMs: 0 },
    },
    profiles: [],
    tasks: [],
    events: [],
    limiter: {
      provider: "gemini",
      threshold: 2,
      paused: false,
      explicitEvents: [],
      recovery: "explicit_only",
      providerUnbanClaimed: false,
    },
    pools: [],
    nextEvent: 1,
  };
}

function statePath(dataDir: string): string {
  return path.join(dataDir, "state.json");
}

export function loadDb(dataDir: string, generation: string): Db {
  const file = statePath(dataDir);
  if (!fs.existsSync(file)) return emptyDb(generation);
  const db = JSON.parse(fs.readFileSync(file, "utf8")) as Db;
  db.pools ??= [];
  db.settings.recoveryEnabled ??= true;
  db.settings.cancellationEnabled ??= true;
  db.settings.idempotencyEnabled ??= true;
  db.settings.deterministicBackoff ??= false;
  db.settings.crashNext ??= null;
  db.settings.poolEnabled ??= true;
  return db;
}

export function saveDb(dataDir: string, db: Db): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = statePath(dataDir);
  const tmp = path.join(dataDir, `state.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, "w");
  fs.writeSync(fd, JSON.stringify(db));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  if (process.env.ORCHESTRA_CRASH_AT === "during_state_write") process.kill(process.pid, "SIGKILL");
  fs.renameSync(tmp, file);
}

let chain: Promise<void> = Promise.resolve();

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fileLock<T>(dataDir: string, fn: () => T): Promise<T> {
  const lock = path.join(dataDir, "service.lock");
  fs.mkdirSync(dataDir, { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid }));
      fs.closeSync(fd);
      try {
        return fn();
      } finally {
        fs.rmSync(lock, { force: true });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const info = JSON.parse(fs.readFileSync(lock, "utf8")) as { pid?: number };
        if (!info.pid || !pidAlive(info.pid)) fs.rmSync(lock, { force: true });
      } catch {
        fs.rmSync(lock, { force: true });
      }
      if (Date.now() - start > 8000) throw new Error("lock_timeout");
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
}

export function updateDb<T>(dataDir: string, generation: string, fn: (db: Db) => T): Promise<T> {
  const run = chain.then(() => fileLock(dataDir, () => {
    const db = loadDb(dataDir, generation);
    const result = fn(db);
    saveDb(dataDir, db);
    return result;
  }));
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
