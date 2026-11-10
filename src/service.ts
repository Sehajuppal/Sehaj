import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gitHead, workspaceDigest } from "./digest.js";
import { parseGeminiStream, spawnGeminiExecutable } from "./gemini-process.js";
import { ContractError, parseHandoffCard, parseResultContract, parseTaskContract, contractSchemasActive, type TaskContract } from "./validate.js";
import { buildLaunchPlan, type GoogleAgent, type LaunchPlan } from "./launch.js";
import { redactText, redactValue } from "./redact.js";
import {
  loadDb,
  updateDb,
  type Db,
  type Health,
  type Profile,
  type Task,
} from "./store.js";

export class OrchestraError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class CrashStop extends Error {
  constructor(readonly point: string) {
    super(`crash:${point}`);
  }
}

const API_ENV = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
]);

const EXPLICIT = new Set(["provider_ban", "provider_suspension", "auth_failure", "quota_exhausted"]);

export function classifyProviderError(input: {
  httpStatus?: number | null;
  code?: string | null;
  message?: string | null;
}): Health["state"] {
  const code = (input.code ?? "").toLowerCase();
  const message = (input.message ?? "").toLowerCase();
  if (code.includes("ban") || message.includes("account_banned") || message.includes("account banned")) {
    return "provider_ban";
  }
  if (code.includes("suspend") || message.includes("account_suspended") || message.includes("account suspended")) {
    return "provider_suspension";
  }
  if (input.httpStatus === 401 || code.includes("unauthorized") || code.includes("invalid_api_key")) return "auth_failure";
  if (input.httpStatus === 429 && (code.includes("quota") || message.includes("quota"))) return "quota_exhausted";
  if (input.httpStatus === 429 || code.includes("rate_limit") || code === "rate") return "rate_limited";
  return "unknown";
}

function workerPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "worker.js");
}

function nowIso(): string {
  return new Date().toISOString();
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function alive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class Orchestra {
  readonly generation = randomUUID();

  constructor(readonly dataDir: string) {
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  private secrets(): string[] {
    const db = loadDb(this.dataDir, this.generation);
    const names = db.profiles.map((profile) => profile.credentialEnvVar).filter((name): name is string => Boolean(name));
    const extra = (process.env.ORCHESTRA_REDACT_SENTINELS ?? "").split(",").filter(Boolean);
    const values: string[] = [];
    for (const name of names.concat(extra)) {
      const value = process.env[name];
      if (value && value.length >= 8) values.push(value);
    }
    return values;
  }

  private emit(db: Db, type: string, taskId: string | null, data: Record<string, unknown>): void {
    const clean = redactValue(data, this.secrets()) as Record<string, unknown>;
    db.events.push({ seq: db.nextEvent++, at: nowIso(), type, taskId, data: clean });
  }

  doctor(): Record<string, unknown> {
    const db = loadDb(this.dataDir, this.generation);
    return {
      ok: true,
      silentMockFallback: false,
      liveGoogleAuthVerified: false,
      realAccountIsolationVerified: false,
      antiBanGuarantee: false,
      exactlyOnceSideEffects: false,
      learnedRoutingImplemented: false,
      empiricalRouting: { implemented: false, roadmap: "docs/ROADMAP.md" },
      banGuarantee: false,
      accounts: db.profiles.map((profile) => ({
        name: profile.name,
        health: profile.health.state,
        pausedUntil: profile.health.pausedUntil,
        quarantine: profile.health.quarantine,
        dayCount: profile.dayCount ?? 0,
        bucketTokens: Math.floor(profile.bucketTokens ?? 0),
        dailyCeiling: db.settings.pacing?.dailyCeiling ?? null,
        perMinute: db.settings.pacing?.perMinute ?? null,
        quietHours: db.settings.pacing?.quietHours ?? null,
        note: "Pacing rests this account. It does not move work to a fresh account after a restriction, and it cannot guarantee no ban.",
      })),
      spendAuthorization: false,
      paidApiFallback: false,
      targetSpeedup: 5,
      targetIsMeasuredClaim: false,
      integrationLevel: "external-worker-mcp",
      nativeCodexAgents: false,
      uiParityVerified: false,
      scope: "partial",
      contracts: contractSchemasActive(),
      budgets: {
        hard: ["concurrency", "task_count", "wall_time"],
        tokens: "unavailable",
        usd: "advisory_not_enforceable",
      },
      isolation: {
        tested: "per-profile HOME, GEMINI_CLI_HOME, config dir, session dir, allowlisted env",
        osKeyringIsolated: false,
        verifiedLive: false,
        homeSufficientForAntigravity: false,
        strategyApplied: "config_dir_and_env_only",
        strategyTemplateNotApplied: "templates/os-user-container.md",
      },
      agents: {
        geminiCli: {
          binary: "gemini",
          processAdapter: "implemented",
          testedExecutable: "tools/fake-gemini.sh (labeled fake, not Google)",
          isolationWorkerImpersonatesGemini: false,
          roleInThisSlice: "process adapter plus separate isolation-worker profiles",
          authInterface: "subscription or cached Google login; API key is one optional method",
          apiDefault: false,
          resume: "--resume <uuid> (latest refused; local gemini --help not run)",
          acp: "gemini --acp exists in docs; camelCase names are not wire methods and are not sent",
          installedVersion: null,
          liveExecution: false,
          sources: [
            "https://geminicli.com/docs/cli/headless/",
            "https://geminicli.com/docs/get-started/configuration.html",
            "https://geminicli.com/docs/cli/acp-mode/",
          ],
        },
        antigravity: {
          binary: "agy",
          equivalentToGeminiCli: false,
          authInterface: "separate unified subscription credentials; not probed",
          apiDefault: false,
          resume: "--conversation <id>",
          stdinClose: "drains the turn; not cancellation",
          softDenyExit0: true,
          installedVersion: null,
          liveExecution: false,
          sources: [
            "https://antigravity.google/docs/cli/headless/",
            "https://antigravity.google/docs/install/",
          ],
        },
      },
      unsupported: ["muse", "minstrel", "paid-api-fallback", "learned-routing"],
      profiles: db.profiles.map((profile) => this.publicProfile(profile)),
      limiter: db.limiter,
      scheduler: "one",
    };
  }

  private publicProfile(profile: Profile): Record<string, unknown> {
    return {
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      agent: profile.agent,
      model: profile.model,
      accountLabel: profile.accountLabel,
      role: profile.role,
      identityClass: profile.identityClass,
      schedulingOptIn: profile.schedulingOptIn,
      authMode: profile.authMode,
      apiOptIn: profile.apiOptIn,
      credentialEnvVar: profile.credentialEnvVar,
      execution: profile.execution,
      geminiBin: profile.geminiBin,
      impersonatesGemini: false,
      workerPid: profile.workerPid,
      sessionId: profile.sessionId,
      health: profile.health,
    };
  }

  async addProfile(input: {
    name: string;
    agent?: GoogleAgent;
    accountLabel: string;
    model?: string | null;
    role?: "main" | "delegated";
    identityClass?: "personal" | "sandbox";
    schedulingOptIn?: boolean;
    authMode?: "subscription" | "api_key";
    apiOptIn?: boolean;
    credentialEnvVar?: string | null;
    execution?: "isolation-worker" | "gemini-process";
    geminiBin?: string | null;
  }): Promise<Record<string, unknown>> {
    return updateDb(this.dataDir, this.generation, (db) => {
      if (db.profiles.some((profile) => profile.name === input.name)) {
        throw new OrchestraError("profile_exists", `Profile ${input.name} already exists.`);
      }
      const authMode = input.authMode ?? "subscription";
      const apiOptIn = input.apiOptIn === true;
      if (authMode === "api_key" && !apiOptIn) {
        throw new OrchestraError("api_not_enabled", "API key auth is optional and requires apiOptIn. It is not the default.");
      }
      const credentialEnvVar = input.credentialEnvVar ?? null;
      if (credentialEnvVar && !/^[A-Z_][A-Z0-9_]*$/.test(credentialEnvVar)) {
        throw new OrchestraError("invalid_env_name", "Credential pointer must be an environment variable name, not a secret.");
      }
      if (credentialEnvVar && API_ENV.has(credentialEnvVar) && !apiOptIn) {
        throw new OrchestraError("api_not_enabled", "Refusing to attach a paid or cloud API variable without an explicit API opt-in.");
      }
      const id = `prf_${randomUUID()}`;
      const root = path.join(this.dataDir, "profiles", id);
      const homeDir = path.join(root, "home");
      const configDir = path.join(root, "config");
      const sessionDir = path.join(root, "session");
      fs.mkdirSync(path.join(homeDir, "tmp"), { recursive: true });
      fs.mkdirSync(configDir, { recursive: true });
      fs.mkdirSync(sessionDir, { recursive: true });
      const execution = input.execution ?? "isolation-worker";
      if (execution === "gemini-process" && !input.geminiBin) {
        throw new OrchestraError("gemini_bin_required", "A gemini-process profile needs a supplied executable path. This does not download Gemini.");
      }
      const agent = input.agent ?? "gemini-cli";
      fs.writeFileSync(
        path.join(configDir, "profile.json"),
        JSON.stringify({ profileId: id, agent, authMode, accountLabel: input.accountLabel }),
      );
      const identityClass = input.identityClass ?? "personal";
      const role = input.role ?? (identityClass === "personal" ? "main" : "delegated");
      const profile: Profile = {
        id,
        name: input.name,
        provider: "gemini",
        agent,
        model: input.model ?? null,
        accountLabel: input.accountLabel,
        role,
        identityClass,
        schedulingOptIn: input.schedulingOptIn === true,
        authMode,
        apiOptIn,
        credentialEnvVar,
        homeDir,
        geminiCliHome: homeDir,
        configDir,
        sessionDir,
        workerPid: null,
        sessionId: null,
        execution,
        geminiBin: input.geminiBin ?? null,
        bucketTokens: 600,
        bucketAt: Date.now(),
        dayKey: new Date().toISOString().slice(0, 10),
        dayCount: 0,
        launchCount: 0,
        lastLaunchAt: 0,
        health: {
          state: "ok",
          eligible: true,
          pausedUntil: null,
          quarantine: false,
          disabled: false,
          providerUnbanClaimed: false,
          lastError: null,
        },
      };
      db.profiles.push(profile);
      this.emit(db, "profile_added", null, { name: profile.name, agent, authMode, schedulingOptIn: profile.schedulingOptIn });
      return this.publicProfile(profile);
    });
  }

  listProfiles(): Record<string, unknown>[] {
    return loadDb(this.dataDir, this.generation).profiles.map((profile) => this.publicProfile(profile));
  }

  launchConfig(name: string, goal = "Describe this workspace in one sentence."): LaunchPlan & { profile: string } {
    const profile = this.mustProfile(name);
    if (profile.authMode === "api_key") {
      throw new OrchestraError("api_launch_refused", "The default launch plan is subscription auth. API mode is optional and not emitted as the worker plan.");
    }
    const plan = buildLaunchPlan(profile.agent, goal, profile.sessionId ?? undefined);
    return { ...plan, profile: profile.name, workerEnvNames: plan.workerEnvNames.concat(profile.credentialEnvVar ? [profile.credentialEnvVar] : []) };
  }

  private mustProfile(name: string): Profile {
    const profile = loadDb(this.dataDir, this.generation).profiles.find((item) => item.name === name);
    if (!profile) throw new OrchestraError("profile_missing", `No profile named ${name}.`);
    return profile;
  }

  private assertBoundary(profile: Profile): void {
    if (!fs.existsSync(profile.configDir)) {
      throw new OrchestraError("profile_config_missing", "Profile config directory is missing. Refusing to fall back to the user home.");
    }
    const link = fs.lstatSync(profile.configDir);
    const realConfig = fs.realpathSync(profile.configDir);
    const realRoot = fs.realpathSync(path.join(this.dataDir, "profiles"));
    if (link.isSymbolicLink() || (realConfig !== realRoot && !realConfig.startsWith(realRoot + path.sep))) {
      throw new OrchestraError("path_escape", "Profile config path escapes the service data directory.");
    }
    if (!fs.existsSync(path.join(profile.configDir, "profile.json"))) {
      throw new OrchestraError("profile_config_missing", "Profile config directory is missing. Refusing to fall back to the user home.");
    }
  }

  async up(name: string): Promise<{ name: string; pid: number; spawned: boolean }> {
    const snapshot = this.mustProfile(name);
    if (snapshot.agent !== "gemini-cli") {
      throw new OrchestraError(
        "live_execution_disabled",
        `${snapshot.agent} is not the Gemini CLI account worker. No Antigravity process is started.`,
      );
    }
    this.assertBoundary(snapshot);
    const existing = snapshot.workerPid;
    if (existing && alive(existing)) return { name, pid: existing, spawned: false };
    const child = spawn(process.execPath, [workerPath()], {
      detached: true,
      stdio: "ignore",
      cwd: snapshot.homeDir,
      env: this.workerEnv(snapshot),
    });
    child.unref();
    const pid = child.pid;
    if (!pid) throw new OrchestraError("spawn_failed", "Worker did not return a pid.");
    const started = path.join(snapshot.sessionDir, "starts.log");
    const deadline = Date.now() + 4000;
    while (!fs.existsSync(started) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!fs.existsSync(started)) throw new OrchestraError("worker_silent", "Worker did not publish a start record.");
    await updateDb(this.dataDir, this.generation, (db) => {
      const profile = db.profiles.find((item) => item.name === name);
      if (!profile) throw new OrchestraError("profile_missing", name);
      profile.workerPid = pid;
    });
    this.maybeCrash("after_worker_pid");
    return { name, pid, spawned: true };
  }

  async down(name: string): Promise<void> {
    const profile = this.mustProfile(name);
    fs.mkdirSync(profile.sessionDir, { recursive: true });
    fs.writeFileSync(path.join(profile.sessionDir, "shutdown"), "1");
    if (profile.workerPid && alive(profile.workerPid)) {
      try {
        process.kill(-profile.workerPid, "SIGTERM");
      } catch {
        try {
          process.kill(profile.workerPid, "SIGTERM");
        } catch {
          /* gone */
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (alive(profile.workerPid)) {
        try {
          process.kill(-profile.workerPid, "SIGKILL");
        } catch {
          try {
            process.kill(profile.workerPid, "SIGKILL");
          } catch {
            /* gone */
          }
        }
      }
    }
    const childFile = path.join(profile.sessionDir, "child.pid");
    if (fs.existsSync(childFile)) {
      const child = Number(fs.readFileSync(childFile, "utf8"));
      if (Number.isFinite(child)) {
        try {
          process.kill(-child, "SIGKILL");
        } catch {
          try {
            process.kill(child, "SIGKILL");
          } catch {
            /* gone */
          }
        }
      }
    }
    await updateDb(this.dataDir, this.generation, (db) => {
      const found = db.profiles.find((item) => item.id === profile.id);
      if (found) found.workerPid = null;
    });
  }

  private workerEnv(profile: Profile): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: profile.homeDir,
      GEMINI_CLI_HOME: profile.geminiCliHome,
      TMPDIR: path.join(profile.homeDir, "tmp"),
      ORCHESTRA_PROFILE_ID: profile.id,
      ORCHESTRA_CONFIG_DIR: profile.configDir,
      ORCHESTRA_SESSION_DIR: profile.sessionDir,
      ORCHESTRA_CREDENTIAL_ENV: profile.credentialEnvVar ?? "",
      ORCHESTRA_GRACE_MS: String(loadDb(this.dataDir, this.generation).settings.graceMs),
    };
    if (profile.credentialEnvVar && !API_ENV.has(profile.credentialEnvVar)) {
      const value = process.env[profile.credentialEnvVar];
      if (value) env[profile.credentialEnvVar] = value;
    }
    return env;
  }

  private maybeCrash(point: string): void {
    if (process.env.ORCHESTRA_CRASH_AT === point) throw new CrashStop(point);
  }

  async delegate(input: {
    profile: string;
    goal: string;
    experiment?: boolean;
    fallbackProfile?: string;
    idempotencyKey?: string;
    mode?: string;
    otherEnvName?: string;
    sessionId?: string | null;
    check?: string | null;
    acceptanceTests?: { id: string; argv: string[]; required: boolean }[];
    wallTimeSec?: number | null;
    parentId?: string | null;
    poolId?: string | null;
    permissions?: string[];
    dependsOn?: string[];
    depthRemaining?: number;
  }): Promise<Record<string, unknown>> {
    if (/\b(spoof|fingerprint|disguise)\b/i.test(`${input.mode ?? ""} ${input.goal}`)) {
      throw new OrchestraError("evasion_rejected", "Refusing to hide, spoof, or disguise the client.");
    }
    if (input.fallbackProfile) {
      await this.assertFallback(input.profile, input.fallbackProfile);
    }
    const prepared = await updateDb(this.dataDir, this.generation, (db) => {
      const profile = db.profiles.find((item) => item.name === input.profile);
      if (!profile) throw new OrchestraError("profile_missing", input.profile);
      if (db.settings.idempotencyEnabled !== false && input.idempotencyKey) {
        const previous = db.tasks.find((task) => task.idempotencyKey === input.idempotencyKey && task.profileId === profile.id);
        const payloadHash = hash({
          goal: input.goal,
          profile: profile.name,
          experiment: input.experiment === true,
          acceptanceTests: input.acceptanceTests ?? [],
          wallTimeSec: input.wallTimeSec ?? null,
        });
        if (previous && previous.payloadHash === payloadHash) return { task: previous, launch: false };
        if (previous) throw new OrchestraError("idempotency_conflict", "Same idempotency key with a different payload.");
      }
      const hold = this.schedulableHold(db, profile, input.experiment === true);
      const running = db.tasks.filter((task) => task.state === "running" && task.kind !== "supervisor").length;
      const payloadHash = hash({
        goal: input.goal,
        profile: profile.name,
        experiment: input.experiment === true,
        acceptanceTests: input.acceptanceTests ?? [],
        wallTimeSec: input.wallTimeSec ?? null,
      });
      const attemptId = `att_${randomUUID()}`;
      const task: Task = {
        id: `task_${randomUUID()}`,
        profileId: profile.id,
        profileName: profile.name,
        agent: profile.agent,
        goal: input.goal,
        state: "queued",
        reason: null,
        attemptId: null,
        sessionId: input.sessionId ?? profile.sessionId,
        ownerGeneration: null,
        idempotencyKey: input.idempotencyKey ?? null,
        payloadHash,
        experiment: input.experiment === true,
        mode: input.mode ?? "ok",
        otherEnvName: input.otherEnvName ?? null,
        cancelRequested: false,
        lateResultRejected: false,
        checkpoint: { profileId: profile.id, sessionId: input.sessionId ?? profile.sessionId, portable: false },
        result: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        kind: "turn",
        parentId: input.parentId ?? null,
        rootId: input.parentId ?? null,
        poolId: input.poolId ?? null,
        depthRemaining: input.depthRemaining ?? 0,
        permissions: input.permissions ?? ["read", "edit"],
        dependsOn: input.dependsOn ?? [],
        pid: null,
        argv: [],
        execution: profile.execution,
        verification: "none",
        check: input.check ?? null,
        plumbingCheck: input.check?.startsWith("check:file-exists:") ? input.check : null,
        acceptanceTests: input.acceptanceTests ?? [],
        baseDigest: null,
        baseCommit: null,
        wallTimeSec: input.wallTimeSec ?? null,
        evidence: null,
        messages: [],
        leaseToken: null,
        leaseEpoch: 0,
        retries: 0,
        notBefore: null,
        handoffPath: null,
        handoffDeadline: null,
      };
      if (hold) {
        task.state = "queued";
        task.reason = hold;
      } else if (db.settings.crashNext === "after_enqueue") {
        db.settings.crashNext = null;
        task.state = "queued";
        task.reason = "crash_after_enqueue";
      } else if (profile.agent !== "gemini-cli") {
        task.state = "blocked";
        task.reason = "live_execution_disabled";
      } else if (profile.execution !== "gemini-process" && (!profile.workerPid || !alive(profile.workerPid))) {
        task.state = "blocked";
        task.reason = "worker_not_up";
      } else if (running >= db.settings.providerCeiling) {
        task.state = "queued";
        task.reason = "provider_ceiling";
      } else {
        const pace = this.pacingBlock(db, profile);
        if (pace) {
          task.state = "queued";
          task.reason = pace;
        } else {
          task.state = "running";
          task.attemptId = attemptId;
          task.ownerGeneration = this.generation;
          task.leaseEpoch += 1;
          task.leaseToken = randomUUID();
        }
      }
      db.tasks.push(task);
      this.emit(db, "delegated", task.id, { state: task.state, profile: profile.name, next_poll_after_ms: 1000 });
      return { task, launch: task.state === "running" };
    });
    if (prepared.launch) await this.launchTask(prepared.task.id);
    return this.publicTask(loadDb(this.dataDir, this.generation).tasks.find((task) => task.id === prepared.task.id)!);
  }

  private schedulableHold(db: Db, profile: Profile, experiment: boolean): string | null {
    if (!profile.schedulingOptIn) throw new OrchestraError("not_opted_in", "Profile is not opted into the scheduler.");
    if (experiment && (profile.identityClass === "personal" || profile.role === "main")) {
      throw new OrchestraError("personal_identity_excluded", "Main personal identities are excluded from experiments by default.");
    }
    if (profile.health.pausedUntil && profile.health.pausedUntil > Date.now()) return "cooldown";
    if (profile.health.disabled || profile.health.quarantine || !profile.health.eligible) return "restricted_same_account";
    if (db.limiter.paused) return "provider_circuit_open";
    return null;
  }

  private async assertFallback(fromName: string, toName: string): Promise<void> {
    const db = loadDb(this.dataDir, this.generation);
    const from = db.profiles.find((profile) => profile.name === fromName);
    const to = db.profiles.find((profile) => profile.name === toName);
    if (!from || !to) throw new OrchestraError("profile_missing", "Fallback profile is unknown.");
    if (to.authMode === "api_key" || to.apiOptIn) {
      throw new OrchestraError("paid_api_fallback", "Paid or API fallback is off. No spend is authorized.");
    }
    if (from.provider === "gemini" && to.provider === "gemini") {
      throw new OrchestraError("google_identity_rotation", "Refusing to move a job between Google identities.");
    }
    const allowed = db.settings.fallbackAllowlist.some((entry) => entry.fromProfile === fromName && entry.toProfile === toName);
    if (!allowed) throw new OrchestraError("fallback_not_allowlisted", "Cross-provider fallback is not on the allowlist.");
  }

  private async launchGemini(taskId: string): Promise<void> {
    const db = loadDb(this.dataDir, this.generation);
    const task = db.tasks.find((item) => item.id === taskId);
    const profile = task ? db.profiles.find((item) => item.id === task.profileId) : undefined;
    if (!task?.attemptId || !profile?.geminiBin) return;
    await this.captureBase(taskId, profile.homeDir);
    const streamPath = path.join(profile.sessionDir, "streams", `${task.attemptId}.ndjson`);
    const childPidFile = path.join(profile.sessionDir, "children", `${task.attemptId}.pid`);
    fs.mkdirSync(path.dirname(childPidFile), { recursive: true });
    const { child, argv } = spawnGeminiExecutable({
      bin: profile.geminiBin,
      goal: task.goal,
      resumeSessionId: task.sessionId ?? undefined,
      cwd: profile.homeDir,
      env: {
        ...this.workerEnv(profile),
        ORCHESTRA_SPAWN_LOG: path.join(profile.sessionDir, "gemini-spawns.log"),
        ORCHESTRA_ARGV_LOG: path.join(profile.sessionDir, "gemini-argv.log"),
        ORCHESTRA_CHILD_PID_FILE: childPidFile,
        ORCHESTRA_LEASE: task.leaseToken ?? "",
        FAKE_PLAN: task.mode.startsWith("plan:") ? task.mode.slice("plan:".length) : "",
        FAKE_COUNTER: path.join(profile.sessionDir, `fault-${task.id}.count`),
        FAKE_NONCE: task.attemptId,
      },
      streamPath,
    });
    const pid = child.pid ?? null;
    if (pid) child.unref();
    await updateDb(this.dataDir, this.generation, (fresh) => {
      const current = fresh.tasks.find((item) => item.id === taskId);
      if (!current) return;
      current.pid = pid;
      current.argv = argv;
      current.updatedAt = nowIso();
      this.emit(fresh, "gemini_spawned", taskId, { pid, argv0: argv[0], resume: argv.includes("--resume"), fake: true });
    });
    if (process.env.ORCHESTRA_CRASH_AT === "after_gemini_spawn") process.kill(process.pid, "SIGKILL");
  }

  private async writeInbox(taskId: string): Promise<void> {
    const db = loadDb(this.dataDir, this.generation);
    const task = db.tasks.find((item) => item.id === taskId);
    const profile = task ? db.profiles.find((item) => item.id === task.profileId) : undefined;
    if (!task?.attemptId || !task.ownerGeneration || !profile) return;
    await this.captureBase(taskId, profile.homeDir);
    const request = {
      attemptId: task.attemptId,
      ownerGeneration: task.ownerGeneration,
      profileId: profile.id,
      sessionId: task.sessionId,
      goal: task.goal,
      mode: task.mode,
      otherEnvName: task.otherEnvName,
    };
    const staging = path.join(profile.sessionDir, "staging");
    fs.mkdirSync(path.join(profile.sessionDir, "inbox"), { recursive: true });
    fs.mkdirSync(staging, { recursive: true });
    const tmp = path.join(staging, `${task.attemptId}.json`);
    fs.writeFileSync(tmp, JSON.stringify(request));
    fs.renameSync(tmp, path.join(profile.sessionDir, "inbox", `${task.attemptId}.json`));
    this.maybeCrash("after_dispatch_ack");
  }

  private async pump(): Promise<void> {
    const ids = await updateDb(this.dataDir, this.generation, (db) => {
      const launched: string[] = [];
      for (const task of db.tasks) {
        if (task.state !== "queued" || task.kind === "supervisor") continue;
        const running = db.tasks.filter((item) => item.state === "running" && item.kind !== "supervisor").length;
        if (running >= db.settings.providerCeiling || db.limiter.paused) break;
        const profile = db.profiles.find((item) => item.id === task.profileId);
        if (!profile) continue;
        if (profile.execution !== "gemini-process" && (!profile.workerPid || !alive(profile.workerPid))) continue;
        if (task.poolId) {
          const pool = db.pools.find((item) => item.id === task.poolId);
          if (!pool || pool.running >= pool.maxConcurrent) continue;
          if (task.dependsOn.some((dep) => {
            const other = db.tasks.find((item) => item.id === dep);
            return !other || (other.state !== "verified" && other.state !== "completed_unverified");
          })) continue;
          pool.running += 1;
        }
        const hold = this.schedulableHold(db, profile, false);
        if (hold) {
          task.reason = hold;
          if (task.poolId) {
            const pool = db.pools.find((item) => item.id === task.poolId);
            if (pool && pool.running > 0) pool.running -= 1;
          }
          continue;
        }
        const pace = this.pacingBlock(db, profile);
        if (pace) {
          task.reason = pace;
          if (task.poolId) {
            const pool = db.pools.find((item) => item.id === task.poolId);
            if (pool && pool.running > 0) pool.running -= 1;
          }
          continue;
        }
        task.state = "running";
        task.reason = null;
        task.attemptId = `att_${randomUUID()}`;
        task.ownerGeneration = this.generation;
        task.leaseEpoch += 1;
        task.leaseToken = randomUUID();
        task.updatedAt = nowIso();
        launched.push(task.id);
      }
      return launched;
    });
    for (const id of ids) await this.launchTask(id);
  }

  private async launchTask(taskId: string): Promise<void> {
    const task = loadDb(this.dataDir, this.generation).tasks.find((item) => item.id === taskId);
    if (!task) return;
    if (task.execution === "gemini-process") await this.launchGemini(taskId);
    else await this.writeInbox(taskId);
  }

  async reap(taskId?: string): Promise<void> {
    const db = loadDb(this.dataDir, this.generation);
    const tasks = db.tasks.filter((task) => (taskId ? task.id === taskId : task.state === "running" || task.state === "cancelling"));
    for (const task of tasks) {
      if (!task.attemptId) continue;
      const profile = db.profiles.find((item) => item.id === task.profileId);
      if (!profile) continue;
      if (task.execution === "gemini-process") {
        await this.reapGemini(task.id);
        continue;
      }
      const out = path.join(profile.sessionDir, "outbox", `${task.attemptId}.json`);
      if (!fs.existsSync(out)) continue;
      const body = JSON.parse(fs.readFileSync(out, "utf8")) as {
        ok?: boolean;
        error?: string;
        sessionId?: string;
        ownerGeneration?: string;
        summary?: string;
        boundary?: Record<string, unknown>;
        attemptId?: string;
      };
      await updateDb(this.dataDir, this.generation, (fresh) => {
        const current = fresh.tasks.find((item) => item.id === task.id);
        const owner = fresh.profiles.find((item) => item.id === task.profileId);
        if (!current || !owner) return;
        const stderr = path.join(owner.sessionDir, "stderr.log");
        if (fs.existsSync(stderr)) {
          const redacted = redactText(fs.readFileSync(stderr, "utf8"), this.secrets());
          fs.writeFileSync(stderr, redacted);
          this.emit(fresh, "stderr", current.id, { text: redacted });
        }
        if (current.cancelRequested || current.state === "cancelled" || current.state === "cancelling") {
          current.state = "cancelled";
          current.lateResultRejected = body.ok === true;
          current.result = null;
          current.updatedAt = nowIso();
          this.emit(fresh, "late_or_cancel", current.id, { rejected: current.lateResultRejected });
          return;
        }
        if (body.ownerGeneration !== current.ownerGeneration || body.attemptId !== current.attemptId) {
          current.state = "failed";
          current.reason = "stale_owner";
          current.result = null;
          current.updatedAt = nowIso();
          return;
        }
        if (!body.ok) {
          current.state = body.error === "cancelled" ? "cancelled" : "failed";
          current.reason = body.error ?? "worker_failed";
          current.updatedAt = nowIso();
          return;
        }
        current.sessionId = body.sessionId ?? current.sessionId;
        owner.sessionId = current.sessionId;
        current.checkpoint = { profileId: owner.id, sessionId: current.sessionId, portable: false };
        current.result = {
          summary: body.summary ?? "",
          sessionId: current.sessionId,
          boundary: body.boundary ?? null,
        };
        current.state = "completed_unverified";
        current.verification = "completed_unverified";
        current.reason = "live_google_not_verified";
        current.updatedAt = nowIso();
          this.emit(fresh, "turn_finished", current.id, {
          state: current.state,
          sessionId: current.sessionId,
          summary: current.result.summary,
        });
      });
    }
  }

  private releasePool(db: Db, task: Task): void {
    if (!task.poolId) return;
    const pool = db.pools.find((item) => item.id === task.poolId);
    if (pool && pool.running > 0) pool.running -= 1;
  }

  private async reapGemini(taskId: string): Promise<void> {
    const snapshot = loadDb(this.dataDir, this.generation);
    const task = snapshot.tasks.find((item) => item.id === taskId);
    const profile = task ? snapshot.profiles.find((item) => item.id === task.profileId) : undefined;
    if (!task?.attemptId || !profile) return;
    if (task.pid && alive(task.pid)) return;
    const streamPath = path.join(profile.sessionDir, "streams", `${task.attemptId}.ndjson`);
    const parsed = fs.existsSync(streamPath) ? parseGeminiStream(fs.readFileSync(streamPath, "utf8")) : null;
    await updateDb(this.dataDir, this.generation, (fresh) => {
      const current = fresh.tasks.find((item) => item.id === taskId);
      const owner = fresh.profiles.find((item) => item.id === task.profileId);
      if (!current || !owner) return;
      const success = parsed?.status === "success" && Boolean(parsed.sessionId);
      if (current.state === "cancelled") {
        if (success) current.lateResultRejected = true;
        return;
      }
      if (current.state !== "running" && current.state !== "cancelling") return;
      if (fresh.settings.recoveryEnabled === false && current.ownerGeneration !== this.generation) {
        current.state = "needs_reconcile";
        current.reason = "recovery_disabled";
        current.verification = "none";
        current.updatedAt = nowIso();
        this.releasePool(fresh, current);
        return;
      }
      if (current.cancelRequested || current.state === "cancelling") {
        current.state = "cancelled";
        current.lateResultRejected = success;
        current.verification = "none";
        current.result = null;
        current.updatedAt = nowIso();
        this.releasePool(fresh, current);
        this.settleSupervisors(fresh);
        this.emit(fresh, "late_or_cancel", current.id, { rejected: current.lateResultRejected, parsedStatus: parsed?.status ?? null });
        return;
      }
      if (parsed?.lease && current.leaseToken && parsed.lease !== current.leaseToken) {
        current.state = "failed";
        current.reason = "stale_owner";
        current.verification = "none";
        current.updatedAt = nowIso();
        this.releasePool(fresh, current);
        return;
      }
      if (!success || !parsed) {
        const retryMs = parsed?.retryAfterMs ?? this.jitterMs(current.retries, fresh.settings.deterministicBackoff === true);
        if (fresh.settings.recoveryEnabled !== false && fresh.settings.poolEnabled && current.retries < fresh.settings.maxRetries && !current.cancelRequested) {
          current.retries += 1;
          current.state = "retry_wait";
          current.reason = parsed?.retryAfterMs ? "retry_after_same_account" : "bounded_retry_same_account";
          current.notBefore = Date.now() + retryMs;
          current.pid = null;
          current.updatedAt = nowIso();
          this.releasePool(fresh, current);
          this.emit(fresh, "retry_scheduled", current.id, { profile: owner.name, retries: current.retries, rotated: false });
          return;
        }
        current.state = "needs_reconcile";
        current.reason = "gemini_result_missing";
        current.updatedAt = nowIso();
        this.releasePool(fresh, current);
        return;
      }
      current.sessionId = parsed.sessionId;
      owner.sessionId = parsed.sessionId;
      current.checkpoint = { profileId: owner.id, sessionId: parsed.sessionId, portable: false };
      if (current.wallTimeSec && Date.now() - Date.parse(current.createdAt) > current.wallTimeSec * 1000) {
        current.state = "failed";
        current.verification = "none";
        current.reason = "wall_time_exceeded";
      } else {
        const outcome = this.acceptanceOutcome(current, owner.homeDir);
        current.state = outcome.state;
        current.verification = outcome.verification;
        current.reason = outcome.reason;
        current.evidence = outcome.evidence;
      }
      current.result = { summary: parsed.response ?? "", sessionId: parsed.sessionId, boundary: null };
      current.updatedAt = nowIso();
      this.releasePool(fresh, current);
      this.emit(fresh, "gemini_parsed", current.id, {
        sessionId: parsed.sessionId,
        status: parsed.status,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        verification: current.verification,
        exitIsEnough: false,
      });
      this.settleSupervisors(fresh);
    });
  }

  private async captureBase(taskId: string, home: string): Promise<void> {
    const baseDigest = workspaceDigest(home);
    const baseCommit = gitHead(home);
    await updateDb(this.dataDir, this.generation, (db) => {
      const task = db.tasks.find((item) => item.id === taskId);
      if (!task) return;
      task.baseDigest = baseDigest;
      task.baseCommit = baseCommit;
    });
  }

  private acceptanceOutcome(task: Task, home: string): {
    state: Task["state"];
    verification: Task["verification"];
    reason: string;
    evidence: Task["evidence"];
  } {
    if (!task.acceptanceTests.length) {
      return {
        state: "completed_unverified",
        verification: "completed_unverified",
        reason: task.plumbingCheck ? "file_exists_is_plumbing_not_verification" : "exit_status_is_not_verification",
        evidence: null,
      };
    }
    const postDigest = workspaceDigest(home);
    const postCommit = gitHead(home);
    if (task.baseDigest && postDigest === task.baseDigest && postCommit === task.baseCommit) {
      return {
        state: "completed_unverified",
        verification: "completed_unverified",
        reason: "preexisting_or_unchanged_artifact",
        evidence: null,
      };
    }
    const checks = task.acceptanceTests.filter((item) => item.required).map((item) => {
      const result = spawnSync(item.argv[0], item.argv.slice(1), {
        cwd: home,
        shell: false,
        encoding: "utf8",
        timeout: 5000,
        env: { PATH: process.env.PATH, HOME: home },
      });
      const stdout = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      return {
        id: item.id,
        exitCode: result.status ?? 1,
        stdoutSha256: createHash("sha256").update(stdout).digest("hex"),
      };
    });
    if (!checks.length || checks.some((item) => item.exitCode !== 0) || !task.attemptId) {
      return { state: "failed", verification: "none", reason: "acceptance_check_failed", evidence: null };
    }
    return {
      state: "verified",
      verification: "verified",
      reason: "independent_acceptance_check",
      evidence: {
        attemptId: task.attemptId,
        baseDigest: task.baseDigest ?? "",
        baseCommit: task.baseCommit,
        postDigest,
        postCommit,
        checks,
      },
    };
  }

  private refreshStale(task: Task, home: string): void {
    if (task.verification !== "verified" || !task.evidence) return;
    if (task.evidence.attemptId !== task.attemptId) {
      task.state = "completed_unverified";
      task.verification = "completed_unverified";
      task.reason = "stale_attempt_evidence";
      return;
    }
    const digest = workspaceDigest(home);
    const commit = gitHead(home);
    if (digest !== task.evidence.postDigest || commit !== task.evidence.postCommit) {
      task.state = "completed_unverified";
      task.verification = "completed_unverified";
      task.reason = "stale_evidence";
    }
  }

  private independentCheck(home: string, check: string): boolean {
    const prefix = "check:file-exists:";
    if (!check.startsWith(prefix)) return false;
    const rel = check.slice(prefix.length);
    if (!rel || rel.includes("..") || path.isAbsolute(rel)) return false;
    return fs.existsSync(path.join(home, rel));
  }

  private settleSupervisors(db: Db): void {
    const supervisors = db.tasks
      .filter((task) => task.kind === "supervisor" && task.state === "running")
      .sort((a, b) => a.depthRemaining - b.depthRemaining);
    for (const supervisor of supervisors) {
      const kids = db.tasks.filter((task) => task.parentId === supervisor.id);
      if (kids.length === 0) continue;
      if (kids.some((kid) => kid.state === "queued" || kid.state === "running" || kid.state === "cancelling")) continue;
      if (kids.some((kid) => kid.kind === "supervisor" && kid.state === "running")) continue;
      if (kids.every((kid) => kid.state === "verified")) {
        supervisor.state = "verified";
        supervisor.verification = "verified";
      } else if (kids.every((kid) => kid.state === "verified" || kid.state === "completed_unverified" || kid.reason === "permission_rejected" || kid.reason === "depth_exceeded")) {
        supervisor.state = "completed_unverified";
        supervisor.verification = "completed_unverified";
      } else if (kids.some((kid) => kid.state === "cancelled")) {
        supervisor.state = "cancelled";
        supervisor.verification = "none";
      } else {
        supervisor.state = "failed";
        supervisor.verification = "none";
      }
      supervisor.updatedAt = nowIso();
    }
  }

  private jitterMs(retries: number, deterministic = false): number {
    const base = Math.min(5000, 100 * 2 ** retries);
    if (deterministic) return base;
    return base + Math.floor(Math.random() * 50);
  }

  private pacingBlock(db: Db, profile: Profile): string | null {
    const cfg = db.settings.pacing;
    const hour = new Date().getUTCHours();
    if (cfg.quietHours && hour >= cfg.quietHours.startHour && hour < cfg.quietHours.endHour) return "quiet_hours";
    const today = new Date().toISOString().slice(0, 10);
    if (profile.dayKey !== today) {
      profile.dayKey = today;
      profile.dayCount = 0;
    }
    if (profile.dayCount >= cfg.dailyCeiling) return "daily_rest";
    const elapsed = Date.now() - profile.bucketAt;
    profile.bucketTokens = Math.min(cfg.perMinute, profile.bucketTokens + (elapsed / 60_000) * cfg.perMinute);
    profile.bucketAt = Date.now();
    if (profile.bucketTokens < 1) return "pacing_rest";
    if (cfg.rampFirst > 0 && profile.launchCount < cfg.rampFirst && Date.now() - profile.lastLaunchAt < cfg.rampGapMs) {
      return "ramp_up";
    }
    profile.bucketTokens -= 1;
    profile.dayCount += 1;
    profile.launchCount += 1;
    profile.lastLaunchAt = Date.now();
    return null;
  }

  private async tickPool(): Promise<void> {
    const db = loadDb(this.dataDir, this.generation);
    if (!db.settings.poolEnabled || db.settings.recoveryEnabled === false) return;
    const now = Date.now();
    const kills: number[] = [];
    await updateDb(this.dataDir, this.generation, (fresh) => {
      for (const task of fresh.tasks) {
        if (task.kind !== "turn" || task.execution !== "gemini-process") continue;
        if (task.state === "waiting_on_human" && task.handoffDeadline && now > task.handoffDeadline) {
          task.state = "failed";
          task.reason = "handoff_timeout";
          task.updatedAt = nowIso();
          continue;
        }
        if (task.cancelRequested && (task.state === "retry_wait" || task.state === "queued" || task.state === "cancelling")) {
          task.state = "cancelled";
          task.verification = "none";
          task.updatedAt = nowIso();
          continue;
        }
        if (task.state === "retry_wait" && (task.notBefore ?? 0) <= now) {
          task.state = "queued";
          task.reason = "retry_ready_same_account";
          task.updatedAt = nowIso();
          continue;
        }
        if (task.state !== "running" || !task.pid || !task.attemptId) continue;
        const profile = fresh.profiles.find((item) => item.id === task.profileId);
        if (!profile) continue;
        const stream = path.join(profile.sessionDir, "streams", `${task.attemptId}.ndjson`);
        const stamp = fs.existsSync(stream) ? fs.statSync(stream).mtimeMs : Date.parse(task.updatedAt);
        if (now - stamp < fresh.settings.stallMs) continue;
        kills.push(task.pid);
        if (task.retries < fresh.settings.maxRetries) {
          task.retries += 1;
          task.state = "retry_wait";
          task.reason = "stall_retry_same_account";
          task.notBefore = now + this.jitterMs(task.retries, fresh.settings.deterministicBackoff === true);
          task.pid = null;
        } else {
          task.state = "failed";
          task.reason = "stalled";
          task.pid = null;
        }
        task.updatedAt = nowIso();
        this.releasePool(fresh, task);
      }
    });
    for (const pid of kills) this.killGroup(pid);
  }

  async tick(): Promise<void> {
    const settings = loadDb(this.dataDir, this.generation).settings;
    if (settings.recoveryEnabled === false) return;
    await this.tickPool();
    await this.pump();
  }

  /** Start queued tasks. Status does not call this. */
  async schedule(): Promise<void> {
    await this.pump();
  }

  async status(id: string): Promise<Record<string, unknown>> {
    const known = loadDb(this.dataDir, this.generation);
    const ids = [id, ...this.treeIds(known, id)];
    for (const taskId of ids) await this.reap(taskId);
    await updateDb(this.dataDir, this.generation, (db) => {
      this.settleSupervisors(db);
    });
    const task = loadDb(this.dataDir, this.generation).tasks.find((item) => item.id === id);
    if (!task) throw new OrchestraError("task_missing", id);
    const profile = loadDb(this.dataDir, this.generation).profiles.find((item) => item.id === task.profileId);
    if (profile) {
      await updateDb(this.dataDir, this.generation, (db) => {
        const current = db.tasks.find((item) => item.id === id);
        if (current) this.refreshStale(current, profile.homeDir);
      });
    }
    const fresh = loadDb(this.dataDir, this.generation).tasks.find((item) => item.id === id);
    if (!fresh) throw new OrchestraError("task_missing", id);
    return this.publicTask(fresh);
  }

  async resume(id: string, opts?: { profile?: string; mode?: string }): Promise<Record<string, unknown>> {
    const task = loadDb(this.dataDir, this.generation).tasks.find((item) => item.id === id);
    if (!task) throw new OrchestraError("task_missing", id);
    if (opts?.profile && opts.profile !== task.profileName) {
      throw new OrchestraError("profile_mismatch", "Resume cannot change the pinned account.");
    }
    if (task.state === "cancelled") throw new OrchestraError("cancelled_not_resumable", "A cancelled task cannot report success later.");
    if (!task.sessionId) throw new OrchestraError("session_missing", "No session is pinned yet.");
    return this.delegate({
      profile: task.profileName,
      goal: `${task.goal} resume`,
      experiment: task.experiment,
      mode: opts?.mode,
      sessionId: task.sessionId,
    });
  }

  async wait(id: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const start = Date.now();
    let last = await this.status(id);
    while (!this.terminal(String(last.state)) && Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      await this.tick();
      last = await this.status(id);
    }
    return { ...last, timedOut: !this.terminal(String(last.state)), next_poll_after_ms: 1000 };
  }

  private terminal(state: string): boolean {
    return ["completed_unverified", "verified", "blocked", "failed", "cancelled", "needs_reconcile"].includes(state);
  }

  async cancel(id: string, opts?: { wait?: boolean; timeoutMs?: number }): Promise<{ state: string; quiescent: boolean; code: number }> {
    const task = loadDb(this.dataDir, this.generation).tasks.find((item) => item.id === id);
    if (!task) throw new OrchestraError("task_missing", id);
    if (loadDb(this.dataDir, this.generation).settings.cancellationEnabled === false) {
      return { state: task.state, quiescent: false, code: 4 };
    }
    const doomed = await updateDb(this.dataDir, this.generation, (db) => {
      const ids = [id, ...this.treeIds(db, id)];
      const pids: number[] = [];
      for (const taskId of ids) {
        const current = db.tasks.find((item) => item.id === taskId);
        if (!current || current.state === "cancelled") continue;
        current.cancelRequested = true;
        if (current.state === "queued" || current.state === "running" || current.state === "retry_wait") current.state = "cancelling";
        current.updatedAt = nowIso();
        if (current.pid) pids.push(current.pid);
        this.emit(db, "cancel_requested", taskId, { profileId: current.profileId });
      }
      return pids;
    });
    for (const pid of doomed) this.killGroup(pid);
    const profile = loadDb(this.dataDir, this.generation).profiles.find((item) => item.id === task.profileId);
    if (profile && task.attemptId) {
      fs.mkdirSync(path.join(profile.sessionDir, "cancel"), { recursive: true });
      fs.writeFileSync(path.join(profile.sessionDir, "cancel", task.attemptId), "1");
    }
    if (!opts?.wait) {
      const state = loadDb(this.dataDir, this.generation).tasks.find((item) => item.id === id)?.state ?? "cancelling";
      return { state, quiescent: this.terminal(state), code: this.terminal(state) ? 0 : 2 };
    }
    const viewed = await this.wait(id, opts.timeoutMs ?? 2000);
    if (this.terminal(String(viewed.state))) await this.pump();
    const quiescent = this.terminal(String(viewed.state));
    return { state: String(viewed.state), quiescent, code: quiescent ? 0 : 2 };
  }

  events(after = 0): unknown[] {
    return loadDb(this.dataDir, this.generation)
      .events.filter((event) => event.seq > after)
      .map((event) => redactValue(event, this.secrets()));
  }

  async reportError(
    name: string,
    input: { httpStatus?: number | null; code?: string | null; message?: string | null; retryAfterMs?: number | null },
  ): Promise<Record<string, unknown>> {
    const state = classifyProviderError(input);
    return updateDb(this.dataDir, this.generation, (db) => {
      const profile = db.profiles.find((item) => item.name === name);
      if (!profile) throw new OrchestraError("profile_missing", name);
      const message = redactText(input.message ?? "", this.secrets()).slice(0, 400);
      profile.health.lastError = {
        state,
        httpStatus: input.httpStatus ?? null,
        sanitizedMessage: message,
        retryAfterMs: input.retryAfterMs ?? null,
        evidenceAt: nowIso(),
        generic403IsSuspension: false,
      };
      profile.health.state = state;
      if (state === "rate_limited") {
        const delay = Math.min(input.retryAfterMs ?? 1000, 60_000);
        profile.health.pausedUntil = Date.now() + delay;
        profile.health.eligible = false;
      } else if (EXPLICIT.has(state)) {
        profile.health.quarantine = true;
        profile.health.eligible = false;
        profile.health.providerUnbanClaimed = false;
        db.limiter.explicitEvents.push({ profileId: profile.id, state, at: nowIso() });
        if (db.limiter.explicitEvents.length >= db.limiter.threshold) {
          db.limiter.paused = true;
          db.limiter.providerUnbanClaimed = false;
        }
      } else {
        profile.health.quarantine = false;
      }
      this.emit(db, "health", null, {
        profile: profile.name,
        state,
        providerPaused: db.limiter.paused,
        generic403IsSuspension: false,
      });
      return { health: profile.health, limiter: db.limiter };
    });
  }

  async providerRecover(): Promise<Record<string, unknown>> {
    return updateDb(this.dataDir, this.generation, (db) => {
      db.limiter.paused = false;
      db.limiter.providerUnbanClaimed = false;
      this.emit(db, "provider_recover", null, {
        choice: "acknowledge_local_resume",
        providerUnbanClaimed: false,
        rotatesGoogleIdentity: false,
        enablesPaidApi: false,
      });
      return {
        paused: false,
        providerUnbanClaimed: false,
        recoveryChoices: ["keep_paused", "acknowledge_local_resume"],
        note: "Local scheduler control only. Google has not been asked to unban anything.",
      };
    });
  }

  async setCeiling(value: number): Promise<void> {
    await updateDb(this.dataDir, this.generation, (db) => {
      db.settings.providerCeiling = value;
    });
  }

  async setGrace(ms: number): Promise<void> {
    await updateDb(this.dataDir, this.generation, (db) => {
      db.settings.graceMs = ms;
    });
  }

  async reconcile(): Promise<{ adopted: number; spawned: number }> {
    let adopted = 0;
    await updateDb(this.dataDir, this.generation, (db) => {
      for (const profile of db.profiles) {
        if (profile.workerPid && alive(profile.workerPid)) adopted += 1;
        if (profile.workerPid && !alive(profile.workerPid)) profile.workerPid = null;
      }
      for (const task of db.tasks) {
        if (task.state === "cancelled") continue;
        if ((task.state === "running" || task.state === "cancelling") && task.profileId) {
          const profile = db.profiles.find((item) => item.id === task.profileId);
          if (profile && !alive(profile.workerPid) && task.state === "running") {
            task.state = "needs_reconcile";
            task.reason = "worker_gone_no_replay";
          }
        }
      }
    });
    await this.reap();
    return { adopted, spawned: 0 };
  }

  async demoTwoGemini(sentinels: { a: string; b: string }): Promise<Record<string, unknown>> {
    const names = ["gemini-a", "gemini-b"];
    for (const [name, envName, label] of [
      ["gemini-a", "GEMINI_SYNTH_A", "sandbox-a"],
      ["gemini-b", "GEMINI_SYNTH_B", "sandbox-b"],
    ] as const) {
      if (!loadDb(this.dataDir, this.generation).profiles.some((profile) => profile.name === name)) {
        await this.addProfile({
          name,
          agent: "gemini-cli",
          accountLabel: label,
          identityClass: "sandbox",
          role: "delegated",
          schedulingOptIn: true,
          authMode: "subscription",
          credentialEnvVar: envName,
        });
      }
      await this.up(name);
    }
    process.env.GEMINI_SYNTH_A = sentinels.a;
    process.env.GEMINI_SYNTH_B = sentinels.b;
    const [first, second] = await Promise.all([
      this.delegate({ profile: "gemini-a", goal: "account A turn", otherEnvName: "GEMINI_SYNTH_B" }),
      this.delegate({ profile: "gemini-b", goal: "account B turn", otherEnvName: "GEMINI_SYNTH_A" }),
    ]);
    const doneA = await this.wait(String(first.id), 4000);
    const doneB = await this.wait(String(second.id), 4000);
    const resumedA = await this.resume(String(first.id));
    const resumedB = await this.resume(String(second.id));
    const finalA = await this.wait(String(resumedA.id), 4000);
    const finalB = await this.wait(String(resumedB.id), 4000);
    return {
      liveGoogleAuthVerified: false,
      paidApiUsed: false,
      agent: "gemini-cli",
      profiles: names,
      turns: [doneA, doneB, finalA, finalB],
      sessionPinned: doneA.sessionId === finalA.sessionId && doneB.sessionId === finalB.sessionId,
      distinctSessions: doneA.sessionId !== doneB.sessionId,
    };
  }

  async benchmark(): Promise<Record<string, unknown>> {
    const serialStart = Date.now();
    const one = await this.delegate({ profile: "gemini-a", goal: "serial", mode: "slow" });
    await this.wait(String(one.id), 4000);
    const two = await this.delegate({ profile: "gemini-a", goal: "serial-2", mode: "slow" });
    await this.wait(String(two.id), 4000);
    const serialMs = Date.now() - serialStart;
    const parallelStart = Date.now();
    const [left, right] = await Promise.all([
      this.delegate({ profile: "gemini-a", goal: "parallel-a", mode: "slow" }),
      this.delegate({ profile: "gemini-b", goal: "parallel-b", mode: "slow" }),
    ]);
    await this.wait(String(left.id), 4000);
    await this.wait(String(right.id), 4000);
    const parallelMs = Date.now() - parallelStart;
    return {
      serialMs,
      parallelMs,
      userInterventions: 0,
      peakProfiles: 2,
      targetSpeedup: 5,
      targetIsMeasuredClaim: false,
      mocksAreProviderEvidence: false,
      learnedRoutingImplemented: false,
      liveGoogleAuthVerified: false,
      note: "Fixture workers only. Not a measurement of Gemini, and not evidence of a 5x gain.",
    };
  }

  private treeIds(db: Db, rootId: string): string[] {
    const out: string[] = [];
    const walk = (parentId: string) => {
      for (const task of db.tasks) {
        if (task.parentId === parentId) {
          out.push(task.id);
          walk(task.id);
        }
      }
    };
    walk(rootId);
    return out;
  }

  private killGroup(pid: number): void {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
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

  async delegateAndWait(input: { goal?: string; taskFile?: string; policy?: string }): Promise<{ id: string; status: string; resultPath: string }> {
    if (input.goal && input.taskFile) throw new OrchestraError("conflicting_input", "Pass a goal or a task file, not both.");
    const policy = input.policy
      ? (JSON.parse(fs.readFileSync(input.policy, "utf8")) as { profile?: string; timeoutMs?: number })
      : {};
    const timeoutMs = policy.timeoutMs ?? 45_000;
    let task: Record<string, unknown>;
    if (input.taskFile) {
      const text = fs.readFileSync(input.taskFile, "utf8");
      if (input.taskFile.endsWith(".json")) task = await this.submitTask(JSON.parse(text) as unknown);
      else {
        if (!policy.profile) throw new OrchestraError("profile_missing", "A policy file with profile is required for a text task file.");
        task = await this.delegate({ profile: policy.profile, goal: text.trim() });
      }
    } else if (input.goal) {
      if (!policy.profile) throw new OrchestraError("profile_missing", "A policy file with profile is required with a goal.");
      task = await this.delegate({ profile: policy.profile, goal: input.goal });
    } else {
      throw new OrchestraError("missing_goal", "Pass a goal or a task file.");
    }
    const waited = await this.wait(String(task.id), timeoutMs);
    return this.compactResult(String(task.id), waited);
  }

  async compactStatus(id: string): Promise<{ id: string; status: string; resultPath: string }> {
    const viewed = await this.status(id);
    return this.compactResult(id, viewed);
  }

  private compactResult(id: string, viewed: Record<string, unknown>): { id: string; status: string; resultPath: string } {
    const dir = path.join(this.dataDir, "briefs");
    fs.mkdirSync(dir, { recursive: true });
    const resultPath = path.join(dir, `${id}.json`);
    fs.writeFileSync(resultPath, JSON.stringify(viewed));
    const status = String(viewed.state ?? "unknown").replace(/[\r\n]+/g, " ").trim();
    return { id, status, resultPath };
  }

  async tune(input: {
    poolEnabled?: boolean;
    stallMs?: number;
    maxRetries?: number;
    perMinute?: number;
    dailyCeiling?: number;
    quietHours?: { startHour: number; endHour: number } | null;
    rampFirst?: number;
    rampGapMs?: number;
    recoveryEnabled?: boolean;
    cancellationEnabled?: boolean;
    idempotencyEnabled?: boolean;
    deterministicBackoff?: boolean;
    crashNext?: "after_enqueue" | "after_spawn" | null;
    providerCeiling?: number;
  }): Promise<Record<string, unknown>> {
    return updateDb(this.dataDir, this.generation, (db) => {
      if (input.poolEnabled !== undefined) db.settings.poolEnabled = input.poolEnabled;
      if (input.stallMs !== undefined) db.settings.stallMs = input.stallMs;
      if (input.maxRetries !== undefined) db.settings.maxRetries = input.maxRetries;
      if (input.perMinute !== undefined) db.settings.pacing.perMinute = input.perMinute;
      if (input.dailyCeiling !== undefined) db.settings.pacing.dailyCeiling = input.dailyCeiling;
      if (input.quietHours !== undefined) db.settings.pacing.quietHours = input.quietHours;
      if (input.rampFirst !== undefined) db.settings.pacing.rampFirst = input.rampFirst;
      if (input.rampGapMs !== undefined) db.settings.pacing.rampGapMs = input.rampGapMs;
      if (input.recoveryEnabled !== undefined) db.settings.recoveryEnabled = input.recoveryEnabled;
      if (input.cancellationEnabled !== undefined) db.settings.cancellationEnabled = input.cancellationEnabled;
      if (input.idempotencyEnabled !== undefined) db.settings.idempotencyEnabled = input.idempotencyEnabled;
      if (input.deterministicBackoff !== undefined) db.settings.deterministicBackoff = input.deterministicBackoff;
      if (input.crashNext !== undefined) db.settings.crashNext = input.crashNext;
      if (input.providerCeiling !== undefined) db.settings.providerCeiling = input.providerCeiling;
      return { poolEnabled: db.settings.poolEnabled, pacing: db.settings.pacing, stallMs: db.settings.stallMs, maxRetries: db.settings.maxRetries, banGuarantee: false };
    });
  }

  async handoff(input: { profile: string; goal: string; constraints: string; doneCheck: string; timeoutMs?: number }): Promise<Record<string, unknown>> {
    const dir = path.join(this.dataDir, "handoff-outbox");
    fs.mkdirSync(dir, { recursive: true });
    return updateDb(this.dataDir, this.generation, (db) => {
      const profile = db.profiles.find((item) => item.name === input.profile);
      if (!profile) throw new OrchestraError("profile_missing", input.profile);
      const task = this.blankTask(profile, input.goal);
      task.state = "waiting_on_human";
      task.reason = "handoff_card_written";
      task.execution = "isolation-worker";
      const card = {
        schema: "handoff-card.v1",
        task_id: task.id,
        goal: input.goal,
        constraints: [input.constraints],
        done_check: [{ id: "done", must_pass: true, evidence: input.doneCheck }],
        result_path: path.join("briefs", `${task.id}.json`),
      };
      try {
        parseHandoffCard(card);
      } catch (error) {
        if (error instanceof ContractError) throw new OrchestraError(error.code, error.message);
        throw error;
      }
      const cardPath = path.join(dir, `${task.id}.json`);
      fs.writeFileSync(cardPath, JSON.stringify(card, null, 2));
      task.handoffPath = cardPath;
      task.handoffDeadline = Date.now() + (input.timeoutMs ?? 60_000);
      db.tasks.push(task);
      this.emit(db, "handoff_written", task.id, { cardPath, museIntegration: false });
      return { id: task.id, state: task.state, cardPath, museIntegration: false };
    });
  }

  async postHandoffWebhook(id: string, url: string): Promise<Record<string, unknown>> {
    const parsed = new URL(url);
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
      throw new OrchestraError("webhook_not_local", "Only a loopback webhook is allowed. Muse UI is not automated.");
    }
    const task = loadDb(this.dataDir, this.generation).tasks.find((item) => item.id === id);
    if (!task?.handoffPath) throw new OrchestraError("handoff_missing", id);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: fs.readFileSync(task.handoffPath, "utf8"),
    });
    return { id, status: response.status, museIntegration: false };
  }

  async ingestHandoff(id: string, file: string): Promise<Record<string, unknown>> {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const stored = await this.submitResult(raw);
    return updateDb(this.dataDir, this.generation, (db) => {
      const task = db.tasks.find((item) => item.id === id);
      if (!task) throw new OrchestraError("task_missing", id);
      if (task.state === "waiting_on_human") {
        task.state = "completed_unverified";
        task.verification = "completed_unverified";
        task.reason = "handoff_reply_not_verification";
        task.updatedAt = nowIso();
      }
      return { ...stored, id: task.id, state: task.state, verification: task.verification, museIntegration: false };
    });
  }

  async submitTask(input: unknown): Promise<Record<string, unknown>> {
    let contract: TaskContract;
    try {
      contract = parseTaskContract(input);
    } catch (error) {
      if (error instanceof ContractError) throw new OrchestraError(error.code, error.message);
      throw error;
    }
    return this.delegate({
      profile: contract.routing.account_profile,
      goal: contract.goal,
      idempotencyKey: contract.id,
      acceptanceTests: contract.acceptance_tests,
      permissions: contract.permissions,
      wallTimeSec: contract.budget.wall_time_sec,
      depthRemaining: contract.depth_remaining,
    });
  }

  async submitResult(input: unknown): Promise<Record<string, unknown>> {
    let contract;
    try {
      contract = parseResultContract(input);
    } catch (error) {
      if (error instanceof ContractError) throw new OrchestraError(error.code, error.message);
      throw error;
    }
    return updateDb(this.dataDir, this.generation, (db) => {
      const task = db.tasks.find((item) => item.idempotencyKey === contract.id || item.id === contract.id);
      if (!task) throw new OrchestraError("unknown_task", "Result id does not match a task.");
      if (contract.parent_id !== task.parentId) {
        throw new OrchestraError("conflicting_result", "Result parent_id does not match the task.");
      }
      this.emit(db, "result_submission_stored", task.id, {
        status: contract.status,
        summary: contract.summary,
        verificationAccepted: false,
        mappedToVerified: false,
      });
      return {
        id: task.id,
        stored: true,
        mappedToVerified: false,
        state: task.state,
        verification: task.verification,
      };
    });
  }

  async message(id: string, text: string, requestId: string): Promise<Record<string, unknown>> {
    return updateDb(this.dataDir, this.generation, (db) => {
      const task = db.tasks.find((item) => item.id === id);
      if (!task) throw new OrchestraError("task_missing", id);
      const prior = task.messages.find((item) => item.requestId === requestId);
      if (prior) return { ...prior, duplicate: true };
      const receipt = { requestId, received: true as const, applied: false as const, restarted: false as const };
      task.messages.push(receipt);
      this.emit(db, "message_received", id, { requestId });
      this.emit(db, "message_not_applied", id, { requestId, reason: "unsupported_steering" });
      return { ...receipt, duplicate: false, reason: "unsupported_steering" };
    });
  }

  async supervise(input: {
    profile: string;
    goal: string;
    depthRemaining: number;
    maxConcurrent: number;
    maxTasks: number;
    permissions: string[];
    wallSec: number;
    children: {
      key: string;
      goal: string;
      dependsOn?: string[];
      permissions?: string[];
      check?: string | null;
      children?: {
        key: string;
        goal: string;
        dependsOn?: string[];
        permissions?: string[];
        check?: string | null;
        children?: never[];
      }[];
    }[];
  }): Promise<Record<string, unknown>> {
    const rootId = await updateDb(this.dataDir, this.generation, (db) => {
      const profile = db.profiles.find((item) => item.name === input.profile);
      if (!profile) throw new OrchestraError("profile_missing", input.profile);
      const hold = this.schedulableHold(db, profile, false);
      if (hold) throw new OrchestraError(hold, `Supervisor stays unstarted while ${hold}.`);
      const poolId = `pool_${randomUUID()}`;
      const root = this.blankTask(profile, input.goal);
      root.kind = "supervisor";
      root.state = "running";
      root.depthRemaining = input.depthRemaining;
      root.permissions = input.permissions;
      root.poolId = poolId;
      root.rootId = root.id;
      db.pools.push({
        id: poolId,
        rootTaskId: root.id,
        maxConcurrent: input.maxConcurrent,
        maxTasks: input.maxTasks,
        tasksCreated: 1,
        running: 0,
        permissions: input.permissions,
        maxDepth: input.depthRemaining,
        deadlineAt: Date.now() + input.wallSec * 1000,
      });
      db.tasks.push(root);
      const add = (
        parent: Task,
        specs: typeof input.children,
      ) => {
        const pool = db.pools.find((item) => item.id === poolId)!;
        const ids = new Map<string, string>();
        for (const spec of specs) {
          pool.tasksCreated += 1;
          const child = this.blankTask(profile, spec.goal);
          child.parentId = parent.id;
          child.rootId = root.id;
          child.poolId = poolId;
          child.depthRemaining = parent.depthRemaining - 1;
          child.permissions = spec.permissions ?? parent.permissions;
          child.check = spec.check ?? null;
          child.plumbingCheck = spec.check?.startsWith("check:file-exists:") ? spec.check : null;
          if (pool.tasksCreated > pool.maxTasks) {
            child.state = "failed";
            child.reason = "task_cap";
          } else if (child.depthRemaining < 0 || (spec.children?.length && child.depthRemaining === 0)) {
            child.state = "failed";
            child.reason = "depth_exceeded";
          } else if (child.permissions.some((permission) => !pool.permissions.includes(permission))) {
            child.state = "failed";
            child.reason = "permission_rejected";
          } else if (spec.children?.length) {
            child.kind = "supervisor";
            child.state = "running";
          } else {
            child.state = "queued";
          }
          db.tasks.push(child);
          ids.set(spec.key, child.id);
          if (spec.children?.length && child.state === "running") add(child, spec.children);
        }
        for (const spec of specs) {
          const id = ids.get(spec.key);
          const child = db.tasks.find((item) => item.id === id);
          if (!child || child.state !== "queued") continue;
          child.dependsOn = (spec.dependsOn ?? []).map((key) => ids.get(key)).filter((value): value is string => Boolean(value));
        }
      };
      add(root, input.children);
      this.emit(db, "supervisor_created", root.id, { poolId, children: input.children.length, maxConcurrent: input.maxConcurrent });
      return root.id;
    });
    await this.pump();
    return this.publicTask(loadDb(this.dataDir, this.generation).tasks.find((task) => task.id === rootId)!);
  }

  private blankTask(profile: Profile, goal: string): Task {
    return {
      id: `task_${randomUUID()}`,
      profileId: profile.id,
      profileName: profile.name,
      agent: profile.agent,
      goal,
      state: "queued",
      reason: null,
      attemptId: null,
      sessionId: null,
      ownerGeneration: null,
      idempotencyKey: null,
      payloadHash: hash({ goal, profile: profile.name }),
      experiment: false,
      mode: "ok",
      otherEnvName: null,
      cancelRequested: false,
      lateResultRejected: false,
      checkpoint: { profileId: profile.id, sessionId: null, portable: false },
      result: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      kind: "turn",
      parentId: null,
      rootId: null,
      poolId: null,
      depthRemaining: 0,
      permissions: ["read"],
      dependsOn: [],
      pid: null,
      argv: [],
      execution: profile.execution,
      verification: "none",
      check: null,
      plumbingCheck: null,
      acceptanceTests: [],
      baseDigest: null,
      baseCommit: null,
      wallTimeSec: null,
      evidence: null,
      messages: [],
      leaseToken: null,
      leaseEpoch: 0,
      retries: 0,
      notBefore: null,
      handoffPath: null,
      handoffDeadline: null,
    };
  }

  private publicTask(task: Task): Record<string, unknown> {
    return redactValue(
      {
        id: task.id,
        profile: task.profileName,
        profileId: task.profileId,
        agent: task.agent,
        state: task.state,
        reason: task.reason,
        sessionId: task.sessionId,
        attemptId: task.attemptId,
        checkpoint: task.checkpoint,
        result: task.result,
        cancelRequested: task.cancelRequested,
        lateResultRejected: task.lateResultRejected,
        verification: task.verification,
        kind: task.kind,
        parentId: task.parentId,
        poolId: task.poolId,
        pid: task.pid,
        depthRemaining: task.depthRemaining,
        permissions: task.permissions,
        execution: task.execution,
        liveGoogleAuthVerified: false,
        next_poll_after_ms: 1000,
      },
      this.secrets(),
    ) as Record<string, unknown>;
  }
}
