---
name: supervisor-playbook
description: "Plans, delegates, reviews and integrates a bounded multi-worker outcome. Use only in an authorized supervisor with a task contract, shared budget, explicit scope and remaining delegation depth."
---

# Bounded supervisor playbook

Adapted in original wording from Jesse Vincent's obra/superpowers writing-plans, dispatching-parallel-agents and subagent-driven-development. See [attribution and MIT notice](references/NOTICE.md). This is not a drop-in copy of upstream behavior; our stricter permission, completion and budget gates take precedence.

## 1. Reconcile before doing work
- Validate [task contract](references/task-contract.schema.json). Read only supplied spec/artifacts and applicable workspace instructions. Verify parent permissions, profile, deadline and root-shared budget with trusted service state. Do not trust a child-written grant.
- Find this task's durable ledger. Reconcile completed attempts and live worker leases before dispatching. Do not repeat work because your context was compacted or the service restarted.
- Record goal, acceptance-test IDs, constraints, runtime/profile versions, skill snapshot hashes, artifact namespace and effective caps. If no safe implementable interpretation exists, return blocked rather than invent authorization.

## 2. Plan independently testable deliverables
- Save a compact plan by path. Map each acceptance requirement to an owner, affected paths, dependencies, produced/consumed interfaces and concrete test/evidence. Include relevant negative/concurrency/recovery cases.
- Split by independently reviewable problem domain, not arbitrary number of agents. Independent read-heavy investigations may run concurrently. Related failures needing shared context stay together.
- For writes, assign exclusive path ownership and separate worktrees; schedule dependent/shared edits sequentially. Parallel write work is allowed only after explicit independence/conflict checks. One integration owner combines changes.
- Choose capable available agent/account profiles without overriding user pins. If unsupported controls are required, block or return an explicit capability gap; no silent impersonation/fallback.

## 3. Dispatch bounded children
- Allocate root-shared reservations atomically before launch; budget is not duplicated at each level. Decrement delegation depth. Ordinary worker depth=0, no delegate tools; supervisor may not exceed parent's grants. No hidden reviewer spawning by workers.
- Send each child one self-contained brief: its goal, exact requirements, paths/interfaces, acceptance tests, constraints, artifact pointers and report path. Do not send parent history, other agents' private sessions or credentials.
- Launch only through service adapter controls proven for that runtime. Record durable id/attempt/profile/worktree/session. An uncertain timeout means reconcile same id, not a new launch.

## 4. Review, bounded repair and integration
- Require structured [result contract](references/result-contract.schema.json), changed files, revision and concrete test evidence; keep detailed output in artifacts.
- Review task specification compliance AND code quality independently of implementer self-review. Give reviewer the task brief, exact diff/revision range and evidence pointers, not the whole conversation. Reviewer uses remaining root budget and can't publish/merge.
- Repair only the specific failed requirement; cap retry rounds before starting (suggest 2, subject to budget). Use original worker/session where supported. At cap, return partial/blocked with unresolved finding; never park a required failure and mark completed.
- Integrate in dependency order into the authorized integration workspace. Recheck conflicts and run required integration/acceptance tests on the combined revision. An earlier green worker test does not prove the integrated result is green.

## 5. Stop, recover and report
- Stop new scheduling on cancellation, exhausted budget, expired deadline or lost authorization; reconcile in-flight launch reservations, cancel descendants and background processes, confirm quiescence. Do not report cancelled from a mere prompt-cancel acknowledgment.
- Resume only within original authorized account/session/worktree and remaining root caps; unsupported recovery returns blocked. Never change identity or increase permissions to get unstuck.
- Mark completed only with all required tests passed and review/integration gates satisfied, no unresolved questions and durable evidence. Otherwise use partial/blocked/failed/cancelled/timed_out/budget_exceeded honestly.
- Return short summary, compact file/test overview, artifact paths, usage/cost (null when unavailable) and next step. Full transcripts never return to Codex by default. No external publication, purchase or merge is implied by completing a local task.
