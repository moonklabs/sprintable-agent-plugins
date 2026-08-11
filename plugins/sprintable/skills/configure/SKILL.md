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

Writes the agent credentials to the channel state dir — `$SPRINTABLE_STATE_DIR` if set,
otherwise `~/.claude/channels/sprintable` — as `.env`. The channel server reads it at boot
and dials the Sprintable Agent Gateway SSE stream. On a machine running several agents, see
**Multi-agent isolation** below.

Arguments passed: `$ARGUMENTS`

The `.env` uses two keys:

- `SPRINTABLE_API_KEY` — your Sprintable agent API key (required).
- `SPRINTABLE_API_URL` — backend base URL (optional; defaults to the dev backend).

---

## Dispatch on arguments

### No args — status and guidance

Read `$DIR/.env` (`$SPRINTABLE_STATE_DIR` if set, else `~/.claude/channels/sprintable`)
and give a complete picture:

1. **API key** — check for `SPRINTABLE_API_KEY`. Show set/not-set; if set, mask
   (show first 6 chars then `…`).
2. **API URL** — show `SPRINTABLE_API_URL` if set, else note the default.
3. **What next**:
   - No key → *"Run `/sprintable:configure <agent_api_key> [api_url]`."*
   - Key set → *"Ready. Restart with `claude --channels plugin:sprintable@moonklabs`
     (or `--dangerously-load-development-channels plugin:sprintable@moonklabs` on a
     non-managed org). Events from your Sprintable conversations arrive in-session."*

Target dir is `$SPRINTABLE_STATE_DIR` if that env var is set, otherwise
`~/.claude/channels/sprintable` (call it `$DIR`). See **Multi-agent isolation** below.

1. Treat the first token of `$ARGUMENTS` as the API key (trim whitespace); if a
   second token is present, treat it as the API URL.
2. `mkdir -p "$DIR"`
3. **Overwrite guard.** Read the existing `$DIR/.env` if present. If it already has a
   `SPRINTABLE_API_KEY=` whose value differs from the new key, STOP and warn:
   *"`$DIR/.env` already holds a different agent key. On a single machine every Claude
   Code session shares this one file, so overwriting it re-points any other agent using
   it. If you're onboarding a second agent on this machine, isolate it first (see
   Multi-agent isolation) instead of overwriting."* Ask for explicit confirmation
   before continuing. (Same key = idempotent, no warning.)
4. Update/add `SPRINTABLE_API_KEY=` (and `SPRINTABLE_API_URL=` if given), preserving
   other keys. Write back, no quotes around the value.
5. `chmod 600 "$DIR/.env"` — the key is a credential.
6. Confirm (mask the key), then show the no-args status.

## Multi-agent isolation

One machine, one agent → the default `~/.claude/channels/sprintable/.env` is fine.

Running **several Sprintable agents on the same machine** (each its own key)? They would
all share that one file and clobber each other. Claude Code exposes no session identifier
to this skill, so there is no fully-automatic split — isolate explicitly by giving each
agent its own state dir at launch:

```bash
# agent A
SPRINTABLE_STATE_DIR=~/.sprintable/agentA claude --channels plugin:sprintable@moonklabs
# agent B
SPRINTABLE_STATE_DIR=~/.sprintable/agentB claude --channels plugin:sprintable@moonklabs
```

Then run `/sprintable:configure <key>` inside each session — it writes to that session's
`$SPRINTABLE_STATE_DIR`, and the channel server reads the same path. (The server also
falls back to `$CLAUDE_PROJECT_DIR/.sprintable/.env` when present.) Injecting the key via
launch env (`AGENT_API_KEY`/`SPRINTABLE_API_KEY`) also isolates — real env wins over the file.

### `clear` — remove

Delete the `SPRINTABLE_API_KEY=` line (or the file if that's the only key).

---

## Implementation notes

- The channels dir may not exist until the server first runs. Missing file = not
  configured, not an error.
- The server reads `.env` once at boot. Credential changes need a session restart
  or `/reload-plugins`. Say so after saving.
- Never echo the full key back to the user — mask it.
