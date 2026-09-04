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
- `SPRINTABLE_API_URL` — backend base URL (optional; defaults to the SaaS backend,
  `https://app.sprintable.ai`). Pass a second argument to point at dev or a self-hosted
  backend instead.

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

### `<agent_api_key> [api_url]` — save

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

### `clear` — remove

Delete the `SPRINTABLE_API_KEY=` line (or the file if that's the only key).

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

---

## Reading tool error responses

story #3405/#3406 (2026-09-04) — when any Sprintable tool call fails, the response is a
JSON object, not a plain sentence. Parse it, don't pattern-match the English/Korean text:

```json
{
  "tool": "submit_channel_post_draft",
  "code": "CHANNEL_POST_GATE_ALREADY_HELD",
  "message": "이 work item은 다른 초안이 이미 승인 절차 중입니다(...)",
  "http_status": 409,
  "detail": { "holding_draft_id": "...", "holding_channel": "threads", "holding_connection_id": "..." }
}
```

- **`code`** is the field to branch on, not `message` (message is free-text and may change
  wording). It's always present — every structured tool error carries a stable `code`.
- **A `code` shaped `HTTP_<status>`** (e.g. `HTTP_500`) means the underlying tool call hit
  that HTTP status but the server didn't attach its own stable `code` to explain why —
  the plugin synthesizes this from the **HTTP status it actually observed**, it isn't
  inventing a diagnosis. Treat it the same as an unrecognized code below: stop and surface
  it, don't guess what specifically went wrong beyond "server returned `<status>`".
- **`http_status`** is `null` when the failure isn't an HTTP response at all — a local
  judgment (e.g. the server answered 200 but the content itself is rejected, like a
  not-yet-approved gate) or a pure input-validation error that never made a network call.
  Don't read `null` as "unknown status" — it means there was no HTTP failure to report.
- **An unrecognized `code`** (one this skill doesn't document below — the plugin added
  something new since this skill was last updated) still arrives with its real value and
  `detail` intact. **Stop and surface `code`, `message`, and `detail` to a human as-is** —
  don't treat it as one of the documented codes just because it's unfamiliar, and don't
  decide on your own what it probably means.
- A tool that hasn't adopted this shape yet (a rare remaining gap — check the tool's own
  skill doc, if any) still returns a plain `"<tool>: <message>"` string instead. If you get
  a plain string where you expected JSON, that's it working as intended for that tool, not
  an error in this doc.

Per-tool code lists (which codes exist, what each one means, who to escalate to) live in
that tool's own skill doc — see `/sprintable:configure-threads` for the channel-posts tools'
codes, for example.

---

## Implementation notes

- The channels dir may not exist until the server first runs. Missing file = not
  configured, not an error.
- The server reads `.env` once at boot. Credential changes need a session restart
  or `/reload-plugins`. Say so after saving.
- Never echo the full key back to the user — mask it.
