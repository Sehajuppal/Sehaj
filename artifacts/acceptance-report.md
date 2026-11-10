# Acceptance report

Date: 2026-11-10. Scope remains **partial**. No live sign-in, no paid API, no user-machine install, no publishing.

## Command

```bash
npm install
./node_modules/typescript/bin/tsc -p tsconfig.json
node --test --test-force-exit --test-concurrency=1 dist/tests/*.test.js
```

Result: **31 passed, 0 failed, 0 skipped.** Log: `artifacts/test-output.txt`.

## Staging drafts

AGY research drafts are vendored only at `orchestration/staging/`. They were not copied to `~/.agents`, `~/.gemini`, or any other live profile. `orchestration/staging/delegate-and-wait/SKILL.md` is the 13-line research companion. The operational skill is `orchestration/skills-src/codex-compact/SKILL.md`. The binding note is `orchestration/staging/CATALOG-BINDING.md`.

Bound catalog: `delegate_and_wait`, `status`, `message`, `cancel`. `delegate_and_wait` takes a goal or a task file, plus an optional policy path. The reply is the task id, one status line, and a result file path. If that wait times out, call `status` or `wait` once. Do not poll in the chat.

Handoff cards are validated against `orchestration/staging/handoff-card/handoff-card.schema.json`. Required fields: `schema`, `task_id`, `goal`, `constraints`, `done_check`. Optional: `inputs`, `result_path`.

## Codex orchestration cost (measured)

No tokenizer is available. Figures below are UTF-8 bytes, and token figures are `ceil(bytes/4)` estimates. Counts are Codex-side orchestration cost only: skill text, server instructions, tool schemas, scripted tool calls, and tool results. Worker and provider tokens are not included.

| | skill bytes | instruction bytes | schema bytes | call bytes | result bytes | round trips | est. tokens | large output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Codex alone | 0 | 0 | 0 | 0 | 0 | 0 | 0 | none |
| Verbose inline | 4485 | 200 | 2388 | 260 | 24078 | 3 | 7853 | inlined |
| Compact `delegate_and_wait` | 806 | 191 | 1070 | 91 | 81 | 1 | 560 | path only |

Compact uses fewer schema bytes (2388 vs 1070, **2.23×**), fewer result bytes, and fewer round trips (3 vs 1). The verbose result byte count uses a fixed 8,000-character stand-in repeated three times so the comparison shows an inlined blob against a path. That **297×** result ratio is the stand-in, not a captured provider log. A live compact tools/list on the same server was 1080 bytes versus 2398 for the full list (**2.22×**, about 270 vs 600 estimated tokens). A live compact round trip was 277 bytes versus 791. This is not a 5× product claim.

Details: `artifacts/codex-overhead.json` and `artifacts/mcp-token-overhead.json`.

## Reliability (measured)

Metric: independently verified completions / launched root tasks. The script is `bench/fault-script.json`. It is deterministic and repeats the same fake-Gemini faults with recovery, cancellation, and idempotency on, then with all three off. No hard case is skipped. `completed_unverified` is not counted as verified.

Injected: worker crash mid-task, scheduler kill after enqueue, scheduler kill after spawn, cancel during queue, cancel during run, cancel during backoff, late success after cancel, Retry-After, expired auth, a child that ignores SIGTERM, duplicate delegate, stale evidence after an edit, and a generic HTTP 403.

| | verified | launched | rate |
| --- | ---: | ---: | ---: |
| Baseline (recovery, cancellation, and idempotency off) | 3 | 14 | 0.214 |
| Recovery on | 6 | 13 | 0.462 |

**Verified ratio: 2.15** (0.462 / 0.214). On this fake suite that meets the 2× bar. Duplicate delegate is one task with idempotency on and two tasks with it off, so the launched counts differ. Cancel, expired auth, SIGTERM, and stale evidence stay unverified on the recovery side and are still in the denominator. The smaller five-plan pool bench is still 5 verified / 1 verified (ratio 5.0, mean recovery 408 ms) and is a different script. Neither number is a live Gemini or Codex measurement.

Details: `artifacts/fault-reliability.json`, `artifacts/fault-reliability.md`, `artifacts/reliability-bench.json`.

## Pacing

One shared limiter. A cooldown or a full slot queues the task on the same profile. The suite waits out Retry-After, and an earlier `schedule` does not spawn. The cooldown is still present after a new process opens the same data directory. An explicit suspension queues the pinned task and does not move it to an idle account. A generic HTTP 403 is not a rotation signal. A goal or mode that asks to spoof or disguise the client is rejected. Retries sooner than Retry-After fail the suite.

## Still open

Spending-budget enforcement is not implemented. Live Gemini, Antigravity, and keyring isolation were not run. Offline pacing and fake accounts do not close those gates. Cursor, Codex app-server, OpenCode, Cline, and Muse remain unverified. MCP is an external tool bridge, not a native Codex subagent. Pacing does not guarantee that a provider will not ban an account.
