# Support matrix

States: **running** (this tree executes it), **partial** (real code, limited contract), **scaffolded** (plan or notes only), **unverified** (not run against the real system).

| Surface | State | Evidence |
| --- | --- | --- |
| Codex-facing MCP stdio: `initialize`, `tools/list`, `tools/call` for `delegate`, `status`, `wait`, `message`, `cancel` | running | `tests/acceptance-cli.test.ts` spawns `dist/src/cli.js mcp` |
| Supervisor DAG, one shared pool, permission ceiling, depth, concurrency | running | Same file, CLI `supervise`. Pool is not copied onto each child. |
| Cancel process group, late success rejected, restart stays cancelled | running | CLI `cancel`/`status`/`reconcile` against `tools/fake-gemini.sh` |
| Abrupt `SIGKILL`, idempotent replay, no second spawn | running | `ORCHESTRA_CRASH_AT=after_gemini_spawn` |
| `verified` vs `completed_unverified` | running | Service-run acceptance argv bound to attempt digest. `check:file-exists` cannot verify. |
| Task and result JSON Schema draft 2020-12 | running | Ajv on CLI and MCP. Non-null token/usd and worker self-verification are rejected. |
| Canonical skill export | running | Staging root only. Dry-run, collision, traversal, and symlink guards. |
| Gemini process adapter launches a supplied executable, parses stream-json, pins `--resume <uuid>` | partial | Tested with the labeled fake `tools/fake-gemini.sh`. Live `gemini` binary not installed and not run. |
| Two synthetic Gemini-profile isolation workers | running | Separate homes, sessions, no API key, no crossover. The worker is **not** Gemini. |
| Antigravity `agy` | scaffolded | Different argv. Not launched. |
| Cursor ACP, Codex app-server, OpenCode, Cline | scaffolded | Not implemented as process adapters in this tree. |
| Muse, minstrel | unsupported | No fabricated runtime. |
| Live Google login, OS keyring, paid API, learned routing, 5x gain | unverified | Explicitly false in `doctor`. |
| Codex native subagent UI | unverified | MCP is an external tool bridge. |

`orchestra doctor` reports `scope: partial`.
