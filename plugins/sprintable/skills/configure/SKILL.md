---
name: configure
description: Set up the Sprintable channel — save the agent API key (and optional API URL). Use when the user pastes a Sprintable agent API key, asks to configure Sprintable, asks "how do I connect to Sprintable" or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
---

# /sprintable:configure — Sprintable Channel Setup

Writes the agent credentials to `~/.claude/channels/sprintable/.env`. The channel
server reads this file at boot and dials the Sprintable Agent Gateway SSE stream.

Arguments passed: `$ARGUMENTS`

The `.env` uses two keys:

- `SPRINTABLE_API_KEY` — your Sprintable agent API key (required).
- `SPRINTABLE_API_URL` — backend base URL (optional; defaults to the dev backend).

---

## Dispatch on arguments

### No args — status and guidance

Read `~/.claude/channels/sprintable/.env` and give a complete picture:

1. **API key** — check for `SPRINTABLE_API_KEY`. Show set/not-set; if set, mask
   (show first 6 chars then `…`).
2. **API URL** — show `SPRINTABLE_API_URL` if set, else note the default.
3. **What next**:
   - No key → *"Run `/sprintable:configure <agent_api_key> [api_url]`."*
   - Key set → *"Ready. Restart with `claude --channels plugin:sprintable@moonklabs`
     (or `--dangerously-load-development-channels plugin:sprintable@moonklabs` on a
     non-managed org). Events from your Sprintable conversations arrive in-session."*

### `<agent_api_key> [api_url]` — save

1. Treat the first token of `$ARGUMENTS` as the API key (trim whitespace); if a
   second token is present, treat it as the API URL.
2. `mkdir -p ~/.claude/channels/sprintable`
3. Read existing `.env` if present; update/add `SPRINTABLE_API_KEY=` (and
   `SPRINTABLE_API_URL=` if given), preserving other keys. Write back, no quotes
   around the value.
4. `chmod 600 ~/.claude/channels/sprintable/.env` — the key is a credential.
5. Confirm, then show the no-args status.

### `clear` — remove

Delete the `SPRINTABLE_API_KEY=` line (or the file if that's the only key).

---

## Implementation notes

- The channels dir may not exist until the server first runs. Missing file = not
  configured, not an error.
- The server reads `.env` once at boot. Credential changes need a session restart
  or `/reload-plugins`. Say so after saving.
- Never echo the full key back to the user — mask it.
