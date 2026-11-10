# OS user or container isolation (template only)

This file is not applied to the host. The running scheduler does not create users, containers, or logins.

Use it only if you later decide that per-profile `HOME` and `GEMINI_CLI_HOME` are not enough for real Google accounts. That decision needs your own machine and your own sign-in. This repository does not do that setup.

## What this slice actually isolates

- One service data directory.
- One home, config directory, and session directory per profile.
- A worker environment that contains `PATH`, those directories, and at most one synthetic credential variable name.
- `GEMINI_API_KEY`, `GOOGLE_API_KEY`, and `GOOGLE_APPLICATION_CREDENTIALS` are omitted unless you explicitly opt into API mode, which the demo does not.

`HOME` does not move an OS keyring. Antigravity's subscription credentials are a separate interface from Gemini CLI. Neither one was signed in here.

## A possible later layout (do not run here)

Run each real Gemini CLI account as a different OS user, or as a container whose home, dbus/keyring socket, and ADC files are not mounted from the host.

```text
os-user gemini-a -> HOME=/home/gemini-a  gemini -p ... --output-format stream-json
os-user gemini-b -> HOME=/home/gemini-b  gemini -p ... --output-format stream-json --resume <uuid>
```

Do not point both users at the same keyring socket. Do not copy `auth` files between them. Do not switch the scheduler onto a paid API key if a subscription account is rate-limited.

Antigravity, if you use it at all, stays `agy` with `--conversation <id>` and its own credential store. It is not a second profile of `gemini`.
