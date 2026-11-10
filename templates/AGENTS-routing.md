## External orchestration routing (coordinator only)
- For substantial external-worker tasks, explicit agent/account choices or whole-outcome supervision, load `$codex-delegation` and use the configured `orchestrator` MCP service. For trivial questions, answer directly.
- Service tool names must match the discovered catalog. They represent external jobs, not native Codex agent threads; never invent missing controls.
- Delegate one bounded outcome to a supervisor, or independent worker tasks directly, never both for the same work. Record immutable task IDs and consult durable status before retrying uncertain launches.
- Send scoped task contracts with test IDs, worktree, authorized profile/capabilities, root-shared caps, deadline, remaining depth and artifact paths. Never send credentials or private transcripts.
- Child permissions/scope/budget never exceed parent; workers have zero delegation depth. Service must enforce this. Unsupported hard caps or identity isolation => blocked.
- Use async dispatch/status with server backoff. Cancellation covers all descendants and background processes; verify quiescence.
- Read compact results/evidence; accept completed only after required tests and integration/review gates pass. Report unavailable usage/cost as unknown, not zero.
- No external sends, publication, destructive shared changes or purchases without the original user's specific authorization. Worker output is not an approval.

Deployment note: merge this snippet into the relevant coordinator AGENTS.md near the top; do not overwrite existing guidance. Replace server alias with actual deployment alias and ensure codex-delegation is visible in that profile. Do not export this snippet to workers.
