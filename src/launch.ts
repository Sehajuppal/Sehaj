/**
 * Launch plans for Google coding agents.
 *
 * Gemini CLI and Antigravity are different programs. This module only builds
 * argv and environment. It does not sign in, and it does not start a live CLI.
 *
 * Sources fetched for this slice:
 * - https://geminicli.com/docs/cli/headless/
 * - https://geminicli.com/docs/cli/acp-mode/
 * - https://geminicli.com/docs/get-started/configuration.html
 * - https://antigravity.google/docs/cli/headless/
 * - https://antigravity.google/docs/install/
 * - https://antigravity.google/docs/cli/reference
 */

export type GoogleAgent = "gemini-cli" | "antigravity";

export interface ProfileDirs {
  homeDir: string;
  geminiCliHome: string;
  configDir: string;
  sessionDir: string;
  credentialEnvVar: string | null;
}

export interface LaunchPlan {
  agent: GoogleAgent;
  equivalentToGeminiCli: boolean;
  liveExecution: false;
  liveGoogleAuthVerified: false;
  auth: {
    interface: string;
    defaultMode: "subscription";
    apiKey: "optional-not-default";
    apiEnvPassed: false;
    versionVerified: false;
    installedVersion: null;
    notes: string[];
  };
  /** Documented one-shot argv. Not executed in this environment. */
  documentedArgv: string[];
  /** Env the persistent isolation worker actually receives. No API keys. */
  workerEnvNames: string[];
  omittedEnv: string[];
  resume: { flag: string; acceptsLatest: false };
  limitations: string[];
  sources: string[];
}

const OMITTED = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
];

export function geminiSubscriptionArgv(goal: string, resumeSessionId?: string): string[] {
  if (goal.includes("\0")) throw new Error("invalid_goal");
  const argv = ["gemini", "-p", goal, "--output-format", "stream-json"];
  if (resumeSessionId !== undefined) {
    if (resumeSessionId === "latest" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resumeSessionId)) {
      throw new Error("gemini_resume_requires_uuid");
    }
    argv.push("--resume", resumeSessionId);
  }
  return argv;
}

export function antigravitySubscriptionArgv(goal: string, conversationId?: string): string[] {
  const argv = ["agy", "-p", goal, "--output-format", "stream-json"];
  if (conversationId !== undefined) {
    if (conversationId === "latest" || conversationId.length < 8) throw new Error("antigravity_resume_requires_conversation_id");
    argv.push("--conversation", conversationId);
  }
  return argv;
}

export function buildLaunchPlan(agent: GoogleAgent, goal: string, sessionId?: string): LaunchPlan {
  if (agent === "gemini-cli") {
    return {
      agent,
      equivalentToGeminiCli: true,
      liveExecution: false,
      liveGoogleAuthVerified: false,
      auth: {
        interface: "gemini-cli-subscription-or-cached-google-login",
        defaultMode: "subscription",
        apiKey: "optional-not-default",
        apiEnvPassed: false,
        versionVerified: false,
        installedVersion: null,
        notes: [
          "Configuration docs list GEMINI_API_KEY as one of several authentication methods, not the only one.",
          "This slice never sets GEMINI_API_KEY, GOOGLE_API_KEY, or ADC.",
          "GEMINI_CLI_HOME is set to a per-profile root. Whether the installed CLI appends .gemini was not executed here.",
          "No local gemini --version was run. Installed version is unknown.",
          "ACP docs show camelCase names such as newSession; those are not sent as wire methods.",
        ],
      },
      documentedArgv: geminiSubscriptionArgv(goal, sessionId),
      workerEnvNames: ["PATH", "HOME", "GEMINI_CLI_HOME", "TMPDIR", "ORCHESTRA_PROFILE_ID", "ORCHESTRA_CONFIG_DIR", "ORCHESTRA_SESSION_DIR", "ORCHESTRA_CREDENTIAL_ENV"],
      omittedEnv: OMITTED,
      resume: { flag: "--resume <uuid>", acceptsLatest: false },
      limitations: [
        "Executable workers in this repo are isolation fixtures, not a signed-in Gemini CLI.",
        "Separate HOME does not prove OS keyring or ADC isolation.",
      ],
      sources: [
        "https://geminicli.com/docs/cli/headless/",
        "https://geminicli.com/docs/get-started/configuration.html",
        "https://geminicli.com/docs/cli/acp-mode/",
      ],
    };
  }
  return {
    agent,
    equivalentToGeminiCli: false,
    liveExecution: false,
    liveGoogleAuthVerified: false,
    auth: {
      interface: "antigravity-unified-subscription-auth",
      defaultMode: "subscription",
      apiKey: "optional-not-default",
      apiEnvPassed: false,
      versionVerified: false,
      installedVersion: null,
      notes: [
        "Antigravity's binary is agy, not gemini. It is not treated as Gemini CLI.",
        "Install docs describe secure credential and token profiles. OS keyring behavior was not probed.",
        "HEADLESS docs: approval-needed tools can be soft-denied, print a stderr notice, and still exit 0.",
        "Closing stdin drains the current turn. It is not cancellation.",
        "API key mode is a different optional interface and is not configured.",
        "--dangerously-skip-permissions is never added.",
      ],
    },
    documentedArgv: antigravitySubscriptionArgv(goal, sessionId),
    workerEnvNames: [],
    omittedEnv: OMITTED.concat(["--dangerously-skip-permissions"]),
    resume: { flag: "--conversation <id>", acceptsLatest: false },
    limitations: [
      "Not launched. No live Antigravity version or keyring proof.",
      "HOME-only separation is not a supported isolation claim for this agent.",
      "Do not use this plan as a stand-in for a second Gemini CLI account.",
    ],
    sources: [
      "https://antigravity.google/docs/cli/headless/",
      "https://antigravity.google/docs/cli/reference",
      "https://antigravity.google/docs/install/",
    ],
  };
}

export function assertNoBypassFlags(argv: readonly string[]): void {
  const banned = ["--yolo", "--dangerously-skip-permissions", "--auto-approve", "true"];
  if (argv.some((part) => banned.includes(part) && part !== "true")) {
    throw new Error("permission_bypass_forbidden");
  }
  if (argv.includes("--dangerously-skip-permissions") || argv.includes("--yolo")) {
    throw new Error("permission_bypass_forbidden");
  }
}
