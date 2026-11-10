import readline from "node:readline";
import type { Orchestra } from "./service.js";

/**
 * MCP stdio, protocol revision 2025-11-25.
 * https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
 * https://modelcontextprotocol.io/specification/2025-11-25/server/tools
 *
 * These tools are an external worker bridge. They are not Codex native subagents.
 * delegate returns a durable id and does not wait for the Google account.
 */

const INSTRUCTIONS =
  "External Gemini account scheduler. delegate returns a durable task id and does not wait. status is read-only. Profiles are explicit. This is not a native Codex agent and it does not sign in to Google.";

const COMPACT_INSTRUCTIONS =
  "Compact external bridge. delegate_and_wait returns id, one status line, and a result file path. If that wait times out, call status once later. Do not poll in the chat. Not a native subagent.";

export function toolCatalog(compact: boolean): { instructions: string; tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] } {
  const compactTools = [
    {
      name: "delegate_and_wait",
      description: "Start from a goal or task file and wait once. Returns id, one status line, and a result file path.",
      inputSchema: {
        type: "object",
        properties: { goal: { type: "string" }, taskFile: { type: "string" }, policy: { type: "string" } },
        additionalProperties: false,
      },
    },
    {
      name: "status",
      description: "One later read. Returns id, one status line, and the result file path. Does not launch work.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    },
    {
      name: "message",
      description: "Record a follow-up. Returns id, one status line, and the result file path.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, text: { type: "string" }, requestId: { type: "string" } },
        required: ["id", "text", "requestId"],
        additionalProperties: false,
      },
    },
    {
      name: "cancel",
      description: "Cancel one task. Returns id, one status line, and the result file path.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    },
  ];
  const tools = compact ? compactTools : [
    {
      name: "delegate",
      description: "Queue one turn on an opted-in profile. Returns id and next_poll_after_ms. Does not wait for completion and does not switch accounts.",
      inputSchema: {
        type: "object",
        properties: {
          profile: { type: "string" },
          goal: { type: "string" },
        },
        required: ["profile", "goal"],
        additionalProperties: false,
      },
    },
    {
      name: "status",
      description: "Read task state. Does not launch work.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "resume",
      description: "New turn on the same pinned profile and session. Rejects a different profile.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, profile: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "wait",
      description: "Block until the task is terminal or the timeout elapses. A timeout leaves the task running.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, timeoutMs: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "message",
      description: "Record a follow-up. Receipt is not application. Unsupported steering does not restart the task.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, text: { type: "string" }, requestId: { type: "string" } },
        required: ["id", "text", "requestId"],
        additionalProperties: false,
      },
    },
    {
      name: "cancel",
      description: "Cancel one task. Does not by itself prove the worker tree is quiescent.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "submit_task",
      description: "Validate a task contract (JSON Schema draft 2020-12) and map it to an internal task. Rejects unknown fields and non-null token or dollar caps.",
      inputSchema: {
        type: "object",
        properties: { taskJson: { type: "string" } },
        required: ["taskJson"],
        additionalProperties: false,
      },
    },
    {
      name: "submit_result",
      description: "Validate a result submission. Worker claims of completion or accepted verification are rejected and never mapped to verified.",
      inputSchema: {
        type: "object",
        properties: { resultJson: { type: "string" } },
        required: ["resultJson"],
        additionalProperties: false,
      },
    },
    {
      name: "doctor",
      description: "Report Gemini CLI versus Antigravity support, isolation, and unverified live Google auth.",
      inputSchema: { type: "object", additionalProperties: false },
    },
  ];
  return { instructions: compact ? COMPACT_INSTRUCTIONS : INSTRUCTIONS, tools };
}

export async function serveMcp(orchestra: Orchestra, compact = false): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin });
  const catalog = toolCatalog(compact);
  const tools = catalog.tools;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
    if (message.method === "notifications/initialized") continue;
    if (message.id === undefined) continue;
    try {
      if (message.method === "initialize") {
        reply(message.id, {
          protocolVersion: "2025-11-25",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "orchestra", version: "0.1.0" },
          instructions: catalog.instructions,
        });
      } else if (message.method === "tools/list") {
        reply(message.id, { tools });
      } else if (message.method === "tools/call") {
        const params = message.params ?? {};
        const name = String(params.name);
        const args = (params.arguments ?? {}) as Record<string, string>;
        const data = await callTool(orchestra, name, args, compact);
        reply(message.id, { content: [{ type: "text", text: JSON.stringify(data) }], isError: false });
      } else if (message.method === "ping") {
        reply(message.id, {});
      } else {
        replyError(message.id, -32601, "method_not_found");
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : "error";
      reply(message.id, { content: [{ type: "text", text: JSON.stringify({ ok: false, error: text }) }], isError: true });
    }
  }
}

async function callTool(orchestra: Orchestra, name: string, args: Record<string, string>, compact = false): Promise<unknown> {
  if (name === "delegate_and_wait") {
    return orchestra.delegateAndWait({ goal: args.goal, taskFile: args.taskFile, policy: args.policy });
  }
  if (compact && name === "status") return orchestra.compactStatus(args.id);
  if (compact && name === "message") {
    await orchestra.message(args.id, args.text, args.requestId);
    return orchestra.compactStatus(args.id);
  }
  if (compact && name === "cancel") {
    await orchestra.cancel(args.id, { wait: false });
    return orchestra.compactStatus(args.id);
  }
  if (name === "doctor") return orchestra.doctor();
  if (name === "submit_task") return orchestra.submitTask(JSON.parse(args.taskJson));
  if (name === "submit_result") return orchestra.submitResult(JSON.parse(args.resultJson));
  if (name === "delegate") {
    return orchestra.delegate({
      profile: args.profile,
      goal: args.goal,
      idempotencyKey: args.idempotencyKey,
      check: args.check,
    });
  }
  if (name === "status") return orchestra.status(args.id);
  if (name === "wait") return orchestra.wait(args.id, Number(args.timeoutMs ?? "30000"));
  if (name === "message") return orchestra.message(args.id, args.text, args.requestId);
  if (name === "resume") return orchestra.resume(args.id, { profile: args.profile });
  if (name === "cancel") return orchestra.cancel(args.id, { wait: args.wait === "true", timeoutMs: Number(args.timeoutMs ?? "2000") });
  throw new Error("unknown_tool");
}

function reply(id: number, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function replyError(id: number, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}
