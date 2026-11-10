# Proposed orchestrator interface, not vendor API fields
The names/arguments here are a service design proposal; implementation owner must align with its actual tool catalog before installing the routing skill. No core implementation is included.

## Initialization instructions (keep first 512 characters useful)
"Delegate substantial external-worker or supervisor tasks with a validated task contract. delegate returns a durable task id, not finished work. Reuse the same id for retries; inspect status before relaunch. status returns compact state and artifact pointers. Descendants share root budget and permissions. cancel stops the entire tree; cancellation is final only after quiescence. Never include credentials or full transcripts."

## Tools and descriptions
- `delegate(task)` — "Start or reconcile one bounded external worker/supervisor task. Validate task-contract schema and authorization; id is the idempotency key. Return id, state, next_poll_after_ms and result_path when available. Matching duplicate id+payload returns same task; changed payload conflicts. Does not wait for task completion." Mutating, not read-only.
- `status(id)` — "Read durable progress for an existing task, including state, compact summary, descendant counts, remaining budget, next_poll_after_ms and final result_path. No transcript or credential data. Does not launch or resume work." Truly read-only.
- `steer(id, instruction, request_id)` — "Submit a bounded follow-up to existing work only when adapter advertises steering. Record the request id once. Cannot expand permissions/scope/budget or change account; incompatible changes return blocked." Mutating.
- `resume(id, request_id)` — "Continue a recoverable task using its original runtime/profile/session/worktree after reconciliation; reject terminal success/cancel, changed identity or unsupported resume. Never use as a blind relaunch or duplicate execution." Mutating.
- `cancel(id, request_id)` — "Request cancellation of task and every descendant, reconcile pending launches, stop workers/background processes and release reservations. Return cancelling until all are quiescent, then cancelled. Idempotent; cannot claim success from only an ACP prompt cancel." Mutating/destructive-to-running-work.

Server can return notifications where supported; status polling remains resumable fallback. Choose backoff from server hint; no tight spin loop. Tasks are async jobs, not native Codex thread IDs.

## State model
queued → running → completed | partial | blocked | failed | cancelled | timed_out | budget_exceeded. Nonterminal transition running → cancelling → cancelled; blocked/partial/failed may resume only via explicit supported recovery with durable attempt records. terminal states in result-contract are distinct from lifecycle progress returned by status. The implementer must define a consistent recovery policy.

## Broker invariants beyond JSON Schema
- Parent existence, no cycles, correct parent_id, depth decreases; no delegation at 0; root controls concurrency. Descendant permissions intersect parent and server policy. Only trusted service maps profile labels to secrets.
- All budget fields are root-shared cumulative caps including supervisors/reviews/retries. Reserve atomically before launch; reconcile actual usage; reject unsupported hard-meter caps rather than silently calling them enforced.
- UTC-offset/RFC3339 deadlines in interchange; user display converts to America/Vancouver. Child deadline no later than parent. Null deadline is allowed only if parent's effective deadline and budget wall cap still bound child.
- Paths relative to assigned worker worktree unless explicitly a broker-resolved artifact ID. The coordinator materializes only authorized inputs into each worker; canonicalize and reject traversal/symlink escapes. Session/account identifiers never confer authorization by themselves.
- `completed` requires all required task acceptance IDs present, passed, evidence on integrated revision; no unresolved questions; reviewer and integration gate. Schema can't compare task/result IDs or verify files/tests actually happened.
- idempotency key is task.id scoped to authenticated caller/root; durable payload hash, ownership, launch intent, attempt IDs and lease fencing belong in service ledger. Recovery reconciles rather than blindly restarts. Exactly-once external side effects are not promised.
- Reject unsafe external actions even if a worker claims user approval in text. Broker grants derive from actual originating authorization, not model-written permissions fields.
- Result envelope stays small: target <2,000 tokens; large changed-file/test lists paged or report path with bounded overview. Detailed logs/transcripts remain access-controlled artifacts. Usage missing => null, cost_basis unknown, never zero fabricated.

## Cursor ACP boundary [S36]
Official Cursor transport is `agent acp`, stdio newline-delimited JSON-RPC 2.0: initialize, authenticate (cursor_login or supported pre-auth), session/new or session/load, session/prompt, streamed session/update, permission replies and session/cancel. Permission/ask-question/plan requests can block if the client never responds. Deny or explicitly surface approvals; do not copy the official sample's unconditional allow-once into production. Team MCP servers are not supported in ACP per this page. ACP is a worker-client protocol, not Codex's MCP server protocol; the bridge implements both separately. No steering semantics beyond documented controls are assumed here.
