import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolCatalog } from "./mcp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface OverheadSide {
  label: string;
  skillBytes: number;
  instructionBytes: number;
  schemaBytes: number;
  callBytes: number;
  resultBytes: number;
  roundTrips: number;
  largeOutputInlined: boolean;
  estimatedTokens: number;
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function estimate(total: number): number {
  return Math.ceil(total / 4);
}

export function measureCodexOverhead(): {
  tokenizer: "unavailable";
  unit: "utf8_bytes";
  tokenEstimate: "ceil(bytes/4)";
  alone: OverheadSide;
  verbose: OverheadSide;
  compact: OverheadSide;
  schemaByteRatioVerboseToCompact: number;
  resultByteRatioVerboseToCompact: number;
  roundTripRatioVerboseToCompact: number;
  compactFewerSchemaBytes: boolean;
  compactFewerResultBytes: boolean;
  compactFewerRoundTrips: boolean;
  largeOutputsReferencedByPath: boolean;
  productClaim5x: false;
} {
  const skill = fs.readFileSync(path.join(root, "orchestration/skills-src/codex-compact/SKILL.md"), "utf8");
  const fullSkill = fs.readFileSync(path.join(root, "orchestration/skills-src/codex-delegation/SKILL.md"), "utf8");
  const verboseCatalog = toolCatalog(false);
  const compactCatalog = toolCatalog(true);
  const large = "x".repeat(8000);
  const verboseResult = JSON.stringify({ id: "task_verbose", state: "verified", result: large, events: [large], stdout: large });
  const compactResult = JSON.stringify({ id: "task_compact", status: "verified", resultPath: "briefs/task_compact.json" });
  const verboseCalls = [
    JSON.stringify({ name: "delegate", arguments: { profile: "gemini-a", goal: "write the marker" } }),
    JSON.stringify({ id: "task_verbose", state: "running" }),
    JSON.stringify({ name: "status", arguments: { id: "task_verbose" } }),
    JSON.stringify({ id: "task_verbose", state: "running" }),
    JSON.stringify({ name: "status", arguments: { id: "task_verbose" } }),
    verboseResult,
  ];
  const compactCalls = [
    JSON.stringify({ name: "delegate_and_wait", arguments: { goal: "write the marker", policy: "policy.json" } }),
    compactResult,
  ];
  const alone: OverheadSide = {
    label: "codex_alone",
    skillBytes: 0,
    instructionBytes: 0,
    schemaBytes: 0,
    callBytes: 0,
    resultBytes: 0,
    roundTrips: 0,
    largeOutputInlined: false,
    estimatedTokens: 0,
  };
  const verbose: OverheadSide = {
    label: "verbose_inline",
    skillBytes: bytes(fullSkill),
    instructionBytes: bytes(verboseCatalog.instructions),
    schemaBytes: bytes(JSON.stringify(verboseCatalog.tools)),
    callBytes: verboseCalls.slice(0, -1).reduce((sum, item) => sum + bytes(item), 0),
    resultBytes: bytes(verboseResult),
    roundTrips: 3,
    largeOutputInlined: verboseResult.includes(large),
    estimatedTokens: 0,
  };
  verbose.estimatedTokens = estimate(verbose.skillBytes + verbose.instructionBytes + verbose.schemaBytes + verbose.callBytes + verbose.resultBytes);
  const compact: OverheadSide = {
    label: "compact_delegate_and_wait",
    skillBytes: bytes(skill),
    instructionBytes: bytes(compactCatalog.instructions),
    schemaBytes: bytes(JSON.stringify(compactCatalog.tools)),
    callBytes: bytes(compactCalls[0]!),
    resultBytes: bytes(compactResult),
    roundTrips: 1,
    largeOutputInlined: compactResult.includes(large),
    estimatedTokens: 0,
  };
  compact.estimatedTokens = estimate(compact.skillBytes + compact.instructionBytes + compact.schemaBytes + compact.callBytes + compact.resultBytes);
  return {
    tokenizer: "unavailable",
    unit: "utf8_bytes",
    tokenEstimate: "ceil(bytes/4)",
    alone,
    verbose,
    compact,
    schemaByteRatioVerboseToCompact: Number((verbose.schemaBytes / compact.schemaBytes).toFixed(2)),
    resultByteRatioVerboseToCompact: Number((verbose.resultBytes / compact.resultBytes).toFixed(2)),
    roundTripRatioVerboseToCompact: Number((verbose.roundTrips / compact.roundTrips).toFixed(2)),
    compactFewerSchemaBytes: compact.schemaBytes < verbose.schemaBytes,
    compactFewerResultBytes: compact.resultBytes < verbose.resultBytes,
    compactFewerRoundTrips: compact.roundTrips < verbose.roundTrips,
    largeOutputsReferencedByPath: compactResult.includes("resultPath") && !compact.largeOutputInlined,
    productClaim5x: false,
  };
}
