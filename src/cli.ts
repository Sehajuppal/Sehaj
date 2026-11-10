#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { runAcpConformance } from "./acp-client.js";
import { reliabilityBench } from "./bench.js";
import { ExportError, exportCanonicalSkills } from "./skills-export.js";
import { CrashStop, Orchestra, OrchestraError } from "./service.js";

const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function has(name: string): boolean {
  return argv.includes(name);
}

const dataDir = path.resolve(flag("--data") ?? path.join(process.cwd(), "data"));
const orchestra = new Orchestra(dataDir);
const commands = new Set([
  "doctor",
  "profile-add",
  "profile-list",
  "launch-config",
  "up",
  "down",
  "delegate",
  "status",
  "resume",
  "wait",
  "events",
  "cancel",
  "reconcile",
  "schedule",
  "report-error",
  "provider-recover",
  "demo-two-gemini",
  "benchmark",
  "mcp",
  "supervise",
  "message",
  "submit-task",
  "submit-result",
  "skills-export",
  "tune",
  "handoff",
  "handoff-ingest",
  "handoff-webhook",
  "acp-check",
  "bench-reliability",
]);
const command = argv.find((arg) => commands.has(arg));

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<number> {
  switch (command) {
    case "doctor":
      print(orchestra.doctor());
      return 0;
    case "profile-add": {
      print(
        await orchestra.addProfile({
          name: required("--name"),
          agent: (flag("--agent") as "gemini-cli" | "antigravity" | undefined) ?? "gemini-cli",
          accountLabel: required("--account"),
          identityClass: (flag("--identity") as "personal" | "sandbox" | undefined) ?? "personal",
          role: flag("--role") as "main" | "delegated" | undefined,
          schedulingOptIn: has("--opt-in"),
          authMode: (flag("--auth") as "subscription" | "api_key" | undefined) ?? "subscription",
          apiOptIn: has("--api-opt-in"),
          credentialEnvVar: flag("--credential-env") ?? null,
          model: flag("--model") ?? null,
          execution: (flag("--execution") as "isolation-worker" | "gemini-process" | undefined) ?? "isolation-worker",
          geminiBin: flag("--gemini-bin") ?? null,
        }),
      );
      return 0;
    }
    case "profile-list":
      print({ profiles: orchestra.listProfiles() });
      return 0;
    case "launch-config":
      print(orchestra.launchConfig(required("--name"), flag("--goal")));
      return 0;
    case "up":
      print(await orchestra.up(required("--name")));
      return 0;
    case "down":
      await orchestra.down(required("--name"));
      print({ ok: true });
      return 0;
    case "supervise": {
      const plan = JSON.parse(fs.readFileSync(required("--plan"), "utf8")) as Parameters<Orchestra["supervise"]>[0];
      print(await orchestra.supervise(plan));
      return 0;
    }
    case "message":
      print(await orchestra.message(required("--task"), required("--text"), required("--request-id")));
      return 0;
    case "submit-task":
      print(await orchestra.submitTask(JSON.parse(fs.readFileSync(required("--file"), "utf8"))));
      return 0;
    case "submit-result":
      print(await orchestra.submitResult(JSON.parse(fs.readFileSync(required("--file"), "utf8"))));
      return 0;
    case "skills-export":
      print(exportCanonicalSkills({
        adapter: required("--adapter"),
        stagingRoot: required("--staging-root"),
        dest: flag("--dest"),
        dryRun: has("--dry-run"),
      }));
      return 0;
    case "delegate": {
      const task = await orchestra.delegate({
        profile: required("--profile"),
        goal: required("--goal"),
        experiment: has("--experiment"),
        fallbackProfile: flag("--fallback-profile"),
        idempotencyKey: flag("--idempotency-key"),
        mode: flag("--mode"),
        check: flag("--check") ?? null,
        sessionId: flag("--session") ?? null,
      });
      print({ ...task, accepted: true, waitsForCompletion: false });
      return 0;
    }
    case "status":
      print(await orchestra.status(required("--task")));
      return 0;
    case "resume":
      print(await orchestra.resume(required("--task"), { profile: flag("--profile") }));
      return 0;
    case "wait":
      print(await orchestra.wait(required("--task"), Number(flag("--timeout-ms") ?? "30000")));
      return 0;
    case "events":
      print({ events: orchestra.events(Number(flag("--after") ?? "0")) });
      return 0;
    case "cancel": {
      const result = await orchestra.cancel(required("--task"), {
        wait: has("--wait"),
        timeoutMs: Number(flag("--timeout-ms") ?? "2000"),
      });
      print(result);
      return result.code;
    }
    case "reconcile":
      print(await orchestra.reconcile());
      return 0;
    case "schedule":
      await orchestra.schedule();
      print({ ok: true });
      return 0;
    case "report-error":
      print(
        await orchestra.reportError(required("--name"), {
          httpStatus: flag("--http-status") ? Number(flag("--http-status")) : null,
          code: flag("--code") ?? null,
          message: flag("--message") ?? null,
          retryAfterMs: flag("--retry-after-ms") ? Number(flag("--retry-after-ms")) : null,
        }),
      );
      return 0;
    case "provider-recover":
      print(await orchestra.providerRecover());
      return 0;
    case "demo-two-gemini": {
      const report = await orchestra.demoTwoGemini({
        a: process.env.GEMINI_SYNTH_A ?? "synthetic-account-a-not-a-google-token",
        b: process.env.GEMINI_SYNTH_B ?? "synthetic-account-b-not-a-google-token",
      });
      print(report);
      return 0;
    }
    case "benchmark":
      print(await orchestra.benchmark());
      return 0;
    case "tune":
      print(await orchestra.tune({
        poolEnabled: flag("--pool") === undefined ? undefined : flag("--pool") === "true",
        stallMs: flag("--stall-ms") ? Number(flag("--stall-ms")) : undefined,
        maxRetries: flag("--retries") ? Number(flag("--retries")) : undefined,
        perMinute: flag("--per-minute") ? Number(flag("--per-minute")) : undefined,
        dailyCeiling: flag("--daily") ? Number(flag("--daily")) : undefined,
        rampFirst: flag("--ramp") ? Number(flag("--ramp")) : undefined,
        rampGapMs: flag("--ramp-gap-ms") ? Number(flag("--ramp-gap-ms")) : undefined,
        quietHours: flag("--quiet") ? { startHour: Number(flag("--quiet")?.split("-")[0]), endHour: Number(flag("--quiet")?.split("-")[1]) } : undefined,
      }));
      return 0;
    case "handoff":
      print(await orchestra.handoff({
        profile: required("--profile"),
        goal: required("--goal"),
        constraints: flag("--constraints") ?? "no account switch; no paid API",
        doneCheck: flag("--done-check") ?? "human confirms the outcome",
        timeoutMs: flag("--timeout-ms") ? Number(flag("--timeout-ms")) : undefined,
      }));
      return 0;
    case "handoff-ingest":
      print(await orchestra.ingestHandoff(required("--task"), required("--file")));
      return 0;
    case "handoff-webhook":
      print(await orchestra.postHandoffWebhook(required("--task"), required("--url")));
      return 0;
    case "acp-check":
      print(await runAcpConformance(required("--bin")));
      return 0;
    case "bench-reliability":
      print(await reliabilityBench(flag("--bin") ?? ""));
      return 0;
    case "mcp": {
      const { serveMcp } = await import("./mcp.js");
      await serveMcp(orchestra, has("--compact"));
      return 0;
    }
    default:
      print({
        ok: false,
        error: { code: "usage", message: "Commands: doctor, profile-add, profile-list, launch-config, up, down, delegate, status, resume, wait, events, cancel, reconcile, schedule, report-error, provider-recover, demo-two-gemini, benchmark, mcp" },
      });
      return 1;
  }
}

function required(name: string): string {
  const value = flag(name);
  if (!value) throw new OrchestraError("missing_flag", `Missing ${name}`);
  return value;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof CrashStop) process.exit(99);
    const coded = error instanceof OrchestraError || error instanceof ExportError ? error.code : "error";
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code: coded, message } })}\n`);
    process.exit(coded === "idempotency_conflict" ? 3 : coded === "usage" ? 1 : 4);
  });
