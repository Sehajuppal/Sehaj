import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Orchestra } from "./service.js";

const CHECK = ["node", "-e", "const fs=require('fs'); const t=fs.readFileSync('bench-marker.txt','utf8'); if(!t.includes('marked')) process.exit(3);"];
const PLANS = ["crash,ok", "badjson,ok", "429,ok", "hang,ok", "ok"];

async function runMode(bin: string, poolEnabled: boolean): Promise<{ verified: number; submitted: number; lost: number; duplicated: number; meanRecoveryMs: number | null }> {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), poolEnabled ? "orch-pool-" : "orch-base-"));
  const orchestra = new Orchestra(data);
  await orchestra.addProfile({
    name: "gem",
    accountLabel: "gem",
    identityClass: "sandbox",
    role: "delegated",
    schedulingOptIn: true,
    execution: "gemini-process",
    geminiBin: bin,
  });
  await orchestra.tune({ poolEnabled, stallMs: 350, maxRetries: 2 });
  const recoveries: number[] = [];
  let verified = 0;
  let lost = 0;
  const ids = new Set<string>();
  for (const plan of PLANS) {
    const started = Date.now();
    const task = await orchestra.delegate({
      profile: "gem",
      goal: "write-bench-marker",
      mode: `plan:${plan}`,
      acceptanceTests: [{ id: "marker", argv: CHECK, required: true }],
    });
    ids.add(String(task.id));
    const done = await orchestra.wait(String(task.id), plan.startsWith("hang") && !poolEnabled ? 900 : 8000);
    if (done.verification === "verified") {
      verified += 1;
      if (plan !== "ok") recoveries.push(Date.now() - started);
    } else lost += 1;
    const snapshot = JSON.parse(fs.readFileSync(path.join(data, "state.json"), "utf8")) as { tasks: { pid: number | null }[] };
    for (const item of snapshot.tasks) {
      if (!item.pid) continue;
      try {
        process.kill(-item.pid, "SIGKILL");
      } catch {
        try {
          process.kill(item.pid, "SIGKILL");
        } catch {
          /* stopped */
        }
      }
    }
  }
  return {
    verified,
    submitted: PLANS.length,
    lost,
    duplicated: PLANS.length - ids.size,
    meanRecoveryMs: recoveries.length ? Math.round(recoveries.reduce((sum, value) => sum + value, 0) / recoveries.length) : null,
  };
}

export async function reliabilityBench(bin: string): Promise<Record<string, unknown>> {
  const executable = bin || path.resolve(process.cwd(), "tools/fake-gemini.sh");
  const baseline = await runMode(executable, false);
  const pooled = await runMode(executable, true);
  const ratio = baseline.verified === 0 ? null : Number((pooled.verified / baseline.verified).toFixed(2));
  return {
    baseline,
    pooled,
    verifiedRatio: ratio,
    claim2x: ratio !== null && ratio >= 2,
    note: "Fake Gemini faults only. Not a live provider measurement. Same-account retries only.",
  };
}
