# Limitations

- No Google account was signed in. Tests use synthetic environment values such as `GEMINI_SYNTH_A`. That is not proof of live account isolation, keyrings, or quota behavior.
- The persistent process is the repo worker, not `gemini`. It applies the same directory and environment boundary the launch plan describes.
- `GEMINI_CLI_HOME` is set per profile. This run did not execute Gemini CLI, so it does not prove how a given version joins that path with `.gemini`, OAuth files, or a keyring.
- Antigravity was not installed or authenticated. HOME-only isolation is not claimed for it.
- Generic HTTP 403 is stored as `unknown` with a timestamp. It does not establish a suspension or a ban.
- Provider recovery is a local scheduler flag. It does not tell Google to reinstate an account.
- Hard ceilings the service can enforce are concurrency, task count, and wall time. Token totals are unavailable. Dollar amounts are not enforceable and are rejected if a contract sets a number. Unknown cost is not stored as zero.
- Per-account pacing, quiet hours, and Retry-After can rest an account. They do not guarantee the provider will not ban it, and they do not move work onto a fresh account after a restriction.
- Cancellation of a turn does not promise exactly-once side effects on a future real CLI.
- A 5x improvement is a target in the roadmap, not a result from these fixtures.
- Active task, result, and handoff-card documents are checked with Ajv (draft 2020-12) at submit and handoff time. The research drafts under `orchestration/staging/` stay in the repo. Nothing from this run is copied into `~/.agents`, `~/.gemini`, or another live profile. `CODEX_HOME` is not treated as a switch that moves that skills directory.
- Spending-budget enforcement is not implemented. Offline pacing and fake-account tests do not close that gate, and they do not close live Gemini or keyring isolation.
