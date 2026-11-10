# Compact delegation
Supervise the outcome in `outcome.md` and wait; don't paste worker logs, just use the result file.
This is a slim companion to the full delegation skill, not a replacement.
Bound tools: `delegate_and_wait`, `status`, `message`, and `cancel`.
Call `delegate_and_wait` with a goal or a task file, and an optional policy path.
The reply is only the task id, one status line, and a result file path. Logs stay on disk.
If that wait times out, call `status` or `wait` once later. Do not poll in the chat.
Keep the same profile. Do not switch accounts after a limit or a restriction.
This is an external tool bridge, not a native Codex subagent.
Muse has no direct connector. A handoff card is not Muse integration.
Verified means the service ran its own check. Unknown token or dollar cost is not zero.
