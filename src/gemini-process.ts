import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { geminiSubscriptionArgv } from "./launch.js";

/**
 * Process adapter for a Gemini-CLI-shaped executable.
 * It launches the supplied binary, reads its stream-json stdout, and pins
 * resume to an explicit session id. It does not log in and does not add an API key.
 *
 * Stream shape follows the documented headless events (init, message, result):
 * https://geminicli.com/docs/cli/headless/
 * Resume flag is `--resume <uuid>` and `latest` is refused.
 */

export interface GeminiParsed {
  sessionId: string | null;
  response: string | null;
  status: string | null;
  exitIsEnough: false;
  inputTokens: number | null;
  outputTokens: number | null;
  events: number;
  lease: string | null;
  retryAfterMs: number | null;
}

export function parseGeminiStream(ndjson: string): GeminiParsed {
  let sessionId: string | null = null;
  let response: string | null = null;
  let status: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let events = 0;
  let lease: string | null = null;
  let retryAfterMs: number | null = null;
  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    events += 1;
    if (body.event === "init") {
      const id = body.session_id;
      if (typeof id === "string" && id.length > 0) sessionId = id;
    }
    if (body.event === "result") {
      if (typeof body.session_id === "string") sessionId = body.session_id;
      if (typeof body.status === "string") status = body.status;
      if (typeof body.response === "string") response = body.response;
      if (typeof body.lease === "string") lease = body.lease;
      if (typeof body.retry_after_ms === "number") retryAfterMs = body.retry_after_ms;
      const stats = body.stats;
      if (stats && typeof stats === "object") {
        const record = stats as Record<string, unknown>;
        inputTokens = typeof record.input_tokens === "number" ? record.input_tokens : null;
        outputTokens = typeof record.output_tokens === "number" ? record.output_tokens : null;
      }
    }
  }
  return { sessionId, response, status, exitIsEnough: false, inputTokens, outputTokens, events, lease, retryAfterMs };
}

export function geminiProcessArgv(bin: string, goal: string, resumeSessionId?: string): string[] {
  const documented = geminiSubscriptionArgv(goal, resumeSessionId);
  return [bin, ...documented.slice(1)];
}

export function spawnGeminiExecutable(input: {
  bin: string;
  goal: string;
  resumeSessionId?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  streamPath: string;
}): { child: ChildProcess; argv: string[] } {
  if (!fs.existsSync(input.bin)) throw new Error(`gemini_executable_missing:${input.bin}`);
  const argv = geminiProcessArgv(input.bin, input.goal, input.resumeSessionId);
  const child = spawn(argv[0], argv.slice(1), {
    cwd: input.cwd,
    env: { ...input.env, ORCHESTRA_STREAM_PATH: input.streamPath },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  fs.mkdirSync(path.dirname(input.streamPath), { recursive: true });
  const stream = fs.createWriteStream(input.streamPath, { flags: "a" });
  child.stdout?.on("data", (chunk: Buffer) => {
    stream.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stream.write(chunk);
  });
  child.on("exit", () => {
    stream.end();
  });
  (child.stdout as { unref?: () => void } | null)?.unref?.();
  (child.stderr as { unref?: () => void } | null)?.unref?.();
  child.unref();
  return { child, argv };
}
