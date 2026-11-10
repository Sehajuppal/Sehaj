import { spawn } from "node:child_process";
import readline from "node:readline";

/**
 * ACP stdio skeleton. Default-deny permissions. Not a Muse or Cursor integration.
 * Wire methods are slash names. CamelCase aliases are ignored.
 */
export async function runAcpConformance(bin: string): Promise<{ permission: string | null; question: string | null; hung: false; muse: false }> {
  const child = spawn(process.execPath, [bin], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
  const rl = readline.createInterface({ input: child.stdout! });
  let nextId = 1;
  const pending = new Map<number, (value: unknown) => void>();
  const send = (method: string, params: unknown) => {
    const id = nextId++;
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve) => pending.set(id, resolve));
  };
  const respond = (id: number, result: unknown) => {
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  };
  const done = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("acp_hung")), 3000);
    rl.on("line", (line) => {
      if (process.env.ACP_DEBUG) process.stderr.write(`C ${line}\n`);
      const msg = JSON.parse(line) as { id?: number; method?: string; result?: unknown; error?: unknown };
      if (msg.id && pending.has(msg.id) && (msg.result || msg.error)) {
        pending.get(msg.id)?.(msg.result);
        pending.delete(msg.id);
        return;
      }
      if (msg.method === "session/request_permission" && msg.id) {
        respond(msg.id, { outcome: { outcome: "selected", optionId: "reject-once" } });
        return;
      }
      if (msg.method === "cursor/ask_question" && msg.id) {
        respond(msg.id, { outcome: { outcome: "cancelled" } });
        return;
      }
      if (msg.method === "sessionNew" || msg.method === "newSession") {
        clearTimeout(timer);
        reject(new Error("camel_case_wire_name"));
      }
    });
    send("initialize", { protocolVersion: 1, clientInfo: { name: "orchestra-acp-skeleton", version: "0.1.0" } })
      .then(() => send("session/new", { cwd: process.cwd(), mcpServers: [] }))
      .then(() => send("session/prompt", { sessionId: "fake-session", prompt: [{ type: "text", text: "ping" }] }))
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
  try {
    const result = (await done) as { permission?: string | null; question?: string | null };
    return { permission: result.permission ?? null, question: result.question ?? null, hung: false, muse: false };
  } finally {
    child.kill("SIGKILL");
  }
}
