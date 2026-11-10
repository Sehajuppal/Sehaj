---
name: codex-compact
description: "Slim companion to the full delegation skill. Starts one delegate_and_wait job and reads the result file."
---

# Delegate and wait

Companion to `codex-delegation`, not a replacement. Bound catalog: `delegate_and_wait`, `status`, `message`, `cancel`. Staging draft: `orchestration/staging/delegate-and-wait/SKILL.md`.

Supervise the outcome in `outcome.md` and wait; don't paste worker logs, just use the result file.

Call `delegate_and_wait` once with a goal or a task file, plus an optional policy path. The reply is only the task id, one status line, and a result file path.

If that wait times out, call `status` or `wait` once later. Do not poll in the chat. Do not mint a new id.

`cancel` stops the task. Do not switch accounts after a limit or a restriction.
