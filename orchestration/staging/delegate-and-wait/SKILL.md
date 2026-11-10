---
name: delegate-and-wait
description: "Start one external orchestrator job, wait on compact status, and read the result file. Use when Codex should delegate a bounded outcome instead of doing the work itself."
---

# Delegate and wait

1. For a substantial external or multi-agent outcome, call `delegate` once with a compact task: `id`, [handoff card](references/handoff-card.example.yaml) (`goal`, `constraints`, `done_check`), worktree, authorized profile or capability, budget, deadline, and depth. Do not send credentials or transcripts.
2. Expect a quick ack only: `id`, brief `state`, optional `next_poll_after_ms`, and `result_path` when ready. The tool return must not include a transcript.
3. If a timeout leaves launch uncertain, call `status` with the same `id` before retrying. Never mint a new id to recover.
4. Poll `status` using the server backoff hint until the state is terminal. Keep each return small: state, one-line summary, `result_path`.
5. Read only the file at `result_path` and the evidence it names. Mark `completed` only if every required `done_check` passed on the integrated revision. Return that brief status plus the path.
6. `cancel` the parent `id` to stop the whole tree, then confirm quiescence. Workers have depth 0. Do not silently switch accounts.
