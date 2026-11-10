#!/usr/bin/env node
/**
 * LABELED FAKE ACP agent. Not Cursor, not Muse, not Gemini.
 * Speaks newline JSON-RPC: initialize, session/new, session/prompt,
 * then blocking session/request_permission and cursor/ask_question.
 */
import fs from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
let nextId = 1;
const pending = new Map<number, (value: unknown) => void>();

function send(message: unknown): void {
  fs.writeSync(1, `${JSON.stringify(message)}\n`);
}

function request(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line) as { id?: number; method?: string; result?: unknown };
  if (msg.id && (msg.result || (msg as { error?: unknown }).error) && !msg.method) {
    pending.get(msg.id)?.(msg.result);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agent: "fake-acp", muse: false } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fake-session" } });
  } else if (msg.method === "session/prompt") {
    void (async () => {
      const permission = (await request("session/request_permission", { options: ["reject-once", "allow-once"] })) as { outcome?: { optionId?: string } };
      const question = (await request("cursor/ask_question", { questions: [{ id: "q1", prompt: "continue?" }] })) as { outcome?: { outcome?: string } };
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          stopReason: "end_turn",
          permission: permission?.outcome?.optionId ?? null,
          question: question?.outcome?.outcome ?? null,
          muse: false,
        },
      });
    })();
  } else if (msg.id !== undefined && msg.method) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown" } });
  }
});
