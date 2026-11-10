# Staging drafts (2026-11-10)

Compact Codex skill and generic handoff card for the next orchestra pass.
**Staging only.** Do not copy these into `~/.agents/skills`, `~/.gemini/config/skills`, or any live profile.

- `delegate-and-wait/SKILL.md` — coordinator skill, under 40 lines. Starts one `delegate`, waits on compact `status`, and returns a brief state plus `result_path`.
- `handoff-card/handoff-card.schema.json` — Muse/generic worker brief: `goal`, `constraints`, `done_check`.
- `delegate-and-wait/references/handoff-card.example.yaml` — worked example (same file as `handoff-card/handoff-card.example.yaml`).

This is a slim companion to `canonical/codex-delegation`, not a replacement for the full policy skill. Tool names stay `delegate` / `status` / `cancel` until the deployed catalog is bound.
