import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SKIP = new Set([
  ".git",
  "streams",
  "inbox",
  "outbox",
  "staging",
  "children",
  "cancel",
  "fake-sessions.json",
  "gemini-spawns.log",
  "gemini-argv.log",
  "starts.log",
  "worker.json",
  "stderr.log",
  "sessions.json",
  "shutdown",
]);

export function workspaceDigest(root: string): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) files.push(full);
    }
  };
  walk(root);
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(root, file));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function gitHead(root: string): string | null {
  if (!fs.existsSync(path.join(root, ".git"))) return null;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}
