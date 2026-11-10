import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CANONICAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../orchestration/skills-src");

const ADAPTER_SKILL = {
  codex: "codex-delegation",
  supervisor: "supervisor-playbook",
  cursor: "worker-result",
  gemini: "worker-result",
  antigravity: "worker-result",
  opencode: "worker-result",
  cline: "worker-result",
} as const;

export type SkillAdapter = keyof typeof ADAPTER_SKILL;

const BLOCKED_SUFFIXES = [".agents", ".codex", ".gemini", ".cursor", ".cline", path.join(".config", "opencode")];

export class ExportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ExportError("path_traversal", "Export destination must stay inside the staging root.");
  }
}

function assertNotLiveProfile(target: string): void {
  const home = path.resolve(os.homedir());
  for (const suffix of BLOCKED_SUFFIXES) {
    const blocked = path.resolve(home, suffix);
    if (target === blocked || target.startsWith(blocked + path.sep)) {
      throw new ExportError("live_profile_forbidden", "Refusing to write a global or live profile skill directory.");
    }
  }
}

function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) {
      throw new ExportError("symlink_source_refused", `Canonical skill path is a symlink: ${path.join(prefix, name)}`);
    }
    if (stat.isDirectory()) out.push(...listFiles(full, path.join(prefix, name)));
    else if (stat.isFile()) out.push(path.join(prefix, name));
  }
  return out;
}

export function exportCanonicalSkills(input: {
  adapter: string;
  stagingRoot: string;
  dest?: string;
  dryRun?: boolean;
}): { adapter: SkillAdapter; skill: string; dryRun: boolean; files: string[]; wrote: boolean } {
  if (!(input.adapter in ADAPTER_SKILL)) {
    throw new ExportError("unknown_adapter", `Unknown skill export adapter: ${input.adapter}`);
  }
  const adapter = input.adapter as SkillAdapter;
  const skill = ADAPTER_SKILL[adapter];
  const stagingRoot = path.resolve(input.stagingRoot);
  const dest = path.resolve(input.dest ?? path.join(stagingRoot, adapter));
  if (fs.existsSync(stagingRoot) && fs.lstatSync(stagingRoot).isSymbolicLink()) {
    throw new ExportError("symlink_dest_refused", "Staging root must not be a symlink.");
  }
  assertInside(stagingRoot, dest);
  assertNotLiveProfile(dest);
  if (fs.existsSync(dest)) {
    if (fs.lstatSync(dest).isSymbolicLink()) {
      throw new ExportError("symlink_dest_refused", "Destination is a symlink. Physical copies only.");
    }
    const existing = fs.readdirSync(dest);
    if (existing.length > 0) {
      throw new ExportError("export_collision", "Destination already has files. Refusing to overwrite.");
    }
  }
  const source = path.join(CANONICAL, skill);
  const files = listFiles(source).map((relative) => path.join(dest, skill, relative));
  if (input.dryRun) return { adapter, skill, dryRun: true, files, wrote: false };
  fs.mkdirSync(path.join(dest, skill), { recursive: true });
  for (const relative of listFiles(source)) {
    const from = path.join(source, relative);
    const to = path.join(dest, skill, relative);
    if (fs.existsSync(to)) throw new ExportError("export_collision", `Refusing to overwrite ${to}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  return { adapter, skill, dryRun: false, files, wrote: true };
}
