# Two Gemini CLI accounts

The running demo schedules two **Gemini CLI** profiles at once. It does not replace them with a paid API, and it does not sign in to Google.

## Accounts, agent, and API

| Piece | Value in this slice |
| --- | --- |
| Provider | `gemini` (one shared circuit breaker) |
| Agent | `gemini-cli` binary name `gemini` |
| Auth used by the demo | subscription / cached Google login plan |
| API key | optional, off unless `--api-opt-in` |
| Antigravity | different agent, binary `agy`, not launched |

Gemini CLI configuration documents `GEMINI_API_KEY` as one of several authentication methods. The headless interface used in the launch plan is:

```text
gemini -p "<goal>" --output-format stream-json
gemini -p "<goal>" --output-format stream-json --resume <uuid>
```

`latest` is rejected. No local `gemini --version` was run, so the installed version is unknown.

Antigravity's documented headless form is different:

```text
agy -p "<goal>" --output-format stream-json --conversation <id>
```

Closing Antigravity's stdin drains a turn. It is not cancellation. A headless approval can be soft-denied and still exit 0. This scheduler does not add `--dangerously-skip-permissions` and does not treat `agy` as `gemini`.

## Persistent worker

`orchestra up --name gemini-a` starts a long-lived process with its own directories:

- `HOME` and `GEMINI_CLI_HOME`: profile home
- `ORCHESTRA_CONFIG_DIR`: profile config (`profile.json` must exist)
- `ORCHESTRA_SESSION_DIR`: inbox, outbox, and `sessions.json`

The process that actually runs here is `dist/src/worker.js`. It checks the profile id and refuses another profile's session id. It is an isolation stand-in, not a signed-in Gemini CLI. The launch-config command prints the `gemini` argv you would use on your machine after you authenticate there.

Resume sends the same session id back to the same profile. A different profile name is rejected. A direct inbox write of the other account's session id is rejected by the worker.

## Scheduler

There is one scheduler. A profile runs only if you pass `--opt-in` (or `schedulingOptIn: true`). Each task names its profile. The provider concurrency ceiling is shared by every Gemini profile and every supervisor path in this process. Queued work is not started by `status`.

Restriction handling:

- Generic HTTP 403 stays `unknown`. It is not a ban or a suspension.
- Explicit suspension, ban, auth failure, or quota events are stored per profile.
- Two explicit events pause **new** Gemini jobs for every profile. Checkpoints stay on the task.
- `provider-recover` is a local choice. It does not claim Google removed a restriction and it does not move the job to another Google identity.
- Paid API fallback is off.

Main profiles (`identityClass: personal` or `role: main`) are rejected for `--experiment` jobs.

## What was not verified

Live Google login, OS keyring separation, Antigravity credentials, and any 5x speedup. See `docs/LIMITATIONS.md` and `templates/os-user-container.md`.
