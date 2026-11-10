# Catalog binding

The research draft in `delegate-and-wait/SKILL.md` left tool names unbound (`delegate` / `status` / `cancel`) and told Codex to poll.

The deployed compact catalog binds those names as follows:

- One-shot path: `delegate_and_wait` (goal or task file, optional policy path).
- Later read: `status`.
- Follow-up: `message`.
- Stop: `cancel`.

If `delegate_and_wait` times out, call `status` or `wait` once. Do not poll in the chat. The reply is only the task id, one status line, and a result file path.

This draft stays in `orchestration/staging/`. Do not copy it into `~/.agents`, `~/.gemini`, or any live profile.
