# Orchestra

One scheduler for opted-in accounts. The working demo runs **two Gemini CLI profiles at the same time** without a paid API and without signing in to Google.

Two different Gemini paths exist:

- `execution: isolation-worker` keeps a long-lived per-account process for directory and environment boundaries. It is not Gemini.
- `execution: gemini-process` launches a supplied executable with `gemini -p … --output-format stream-json` and `--resume <uuid>`. Tests use `tools/fake-gemini.sh`, which is labeled as a fake. No Google login and no paid API.

Antigravity (`agy`) is a different program. It is not a second Gemini CLI account.

## Demo

```bash
npm install
npm run build
export GEMINI_SYNTH_A=synthetic-account-a-not-a-google-token
export GEMINI_SYNTH_B=synthetic-account-b-not-a-google-token
node dist/src/cli.js --data /tmp/orchestra-demo demo-two-gemini
node dist/src/cli.js --data /tmp/orchestra-demo doctor
node dist/src/cli.js --data /tmp/orchestra-demo launch-config --name gemini-a
```

Stdout is JSON. A successful demo sets `liveGoogleAuthVerified` to false and `paidApiUsed` to false. The two session ids differ, and each resume keeps its own session.

Add a profile yourself:

```bash
node dist/src/cli.js --data /tmp/orchestra-demo profile-add \
  --name gemini-a --account sandbox-a --identity sandbox --role delegated \
  --opt-in --credential-env GEMINI_SYNTH_A
node dist/src/cli.js --data /tmp/orchestra-demo up --name gemini-a
node dist/src/cli.js --data /tmp/orchestra-demo delegate --profile gemini-a --goal "Say hello"
node dist/src/cli.js --data /tmp/orchestra-demo status --task <id>
```

`--credential-env` is a variable **name**. The value stays in your environment. Profile list does not print it.

## Tests

```bash
npm test
```

## What is running vs later

| Running now | Not running |
| --- | --- |
| Two opted-in Gemini CLI profiles, one scheduler | Live `gemini` or `agy` |
| Session pin and resume on the same profile | Cross-account resume |
| Provider ceiling, circuit breaker, local recovery | A claim that Google lifted a restriction |
| Subscription launch plan; API off by default | Paid API fallback or purchases |
| MCP `delegate` / `status` / `resume` / `cancel` / `doctor` | Codex-native subagent UI |

Support detail: [docs/SUPPORT_MATRIX.md](docs/SUPPORT_MATRIX.md). Account layout: [docs/GEMINI-ACCOUNTS.md](docs/GEMINI-ACCOUNTS.md). Limits: [docs/LIMITATIONS.md](docs/LIMITATIONS.md). The 5x idea is only a proposal in [docs/ROADMAP.md](docs/ROADMAP.md).

OS users and containers are described in [templates/os-user-container.md](templates/os-user-container.md). Nothing in that file is applied to this machine.

## Interfaces that were read

- Gemini CLI headless: https://geminicli.com/docs/cli/headless/
- Gemini CLI configuration (`GEMINI_API_KEY` is one auth method among several): https://geminicli.com/docs/get-started/configuration.html
- Gemini ACP (`gemini --acp`; documented camelCase names are not sent as wire methods): https://geminicli.com/docs/cli/acp-mode/
- Antigravity headless (`agy`, `--conversation`, soft-deny can exit 0): https://antigravity.google/docs/cli/headless/
- Antigravity install: https://antigravity.google/docs/install/
- MCP tools and stdio: https://modelcontextprotocol.io/specification/2025-11-25/server/tools and https://modelcontextprotocol.io/specification/2025-11-25/basic/transports

Codex MCP examples under `templates/` are disabled samples. They are not installed. Reference task schemas and skills under `contracts/` and `orchestration/skills-src/` were kept from research and are not the executed protocol of this demo. AGY research drafts live only under `orchestration/staging/`. The compact skill binds `delegate_and_wait`, `status`, `message`, and `cancel`. Do not copy that tree into `~/.agents` or `~/.gemini`.

This repository also contains an unrelated existing file, scraper2.py, left unchanged.
