import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";

export class ContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface TaskContract {
  schema_version: "1.0";
  id: string;
  parent_id: null;
  goal: string;
  role: "worker";
  routing: { account_profile: string };
  acceptance_tests: { id: string; description: string; argv: string[]; required: true }[];
  budget: {
    tokens: null;
    usd: null;
    wall_time_sec: number;
    max_concurrent_workers: number;
    max_tasks: number;
  };
  permissions: ("read" | "edit")[];
  depth_remaining: 0;
}

export interface ResultContract {
  schema_version: "1.0";
  id: string;
  parent_id: string | null;
  status: "partial" | "blocked" | "failed" | "cancelled";
  summary: string;
  changed_files?: string[];
  verification: { accepted: false };
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../contracts");
const handoffSchemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../orchestration/staging/handoff-card/handoff-card.schema.json");
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateTaskSchema = ajv.compile(JSON.parse(readFileSync(path.join(root, "task-contract.schema.json"), "utf8")));
const validateResultSchema = ajv.compile(JSON.parse(readFileSync(path.join(root, "result-contract.schema.json"), "utf8")));
const validateHandoffSchema = ajv.compile(JSON.parse(readFileSync(handoffSchemaPath, "utf8")));

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`).join("; ");
}

export function parseTaskContract(input: unknown): TaskContract {
  if (!validateTaskSchema(input)) {
    throw new ContractError("contract_invalid", formatErrors(validateTaskSchema.errors));
  }
  return input as TaskContract;
}

export function parseResultContract(input: unknown): ResultContract {
  if (!validateResultSchema(input)) {
    throw new ContractError("contract_invalid", formatErrors(validateResultSchema.errors));
  }
  return input as ResultContract;
}

export function parseHandoffCard(input: unknown): void {
  if (!validateHandoffSchema(input)) {
    throw new ContractError("handoff_invalid", formatErrors(validateHandoffSchema.errors));
  }
}

export function contractSchemasActive(): { task: string; result: string; handoff: string; draft: "2020-12" } {
  return {
    task: "contracts/task-contract.schema.json",
    result: "contracts/result-contract.schema.json",
    handoff: "orchestration/staging/handoff-card/handoff-card.schema.json",
    draft: "2020-12",
  };
}
