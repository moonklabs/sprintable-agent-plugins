---
name: configure-stibee
description: Set up the Stibee publish connector — save the Stibee workspace AccessToken. Use when the user pastes a Stibee AccessToken, asks to configure Stibee, or asks how to connect Stibee for marketing campaign publishing.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
---

# /sprintable:configure-stibee — Stibee Publish Connector Setup

story #3292([M1·마케팅자동화] 발행 커넥터). Writes the Stibee workspace AccessToken to the
**same** channel state dir `/sprintable:configure` already uses — `$SPRINTABLE_STATE_DIR`
if set, otherwise `~/.claude/channels/sprintable` — as `.env`. The channel server (`server.ts`)
loads every `KEY=VALUE` line from that file into `process.env` generically at boot, so no
separate loader is needed for this key.

Arguments passed: `$ARGUMENTS`

The `.env` gains one key:

- `STIBEE_ACCESS_TOKEN` — the Stibee workspace API key (from Stibee's [워크스페이스 설정
  > API 키]), required by the `publish_stibee_campaign` MCP tool. Not OAuth — a static
  workspace token sent as the `AccessToken` header on every Stibee v2 API call.

---

## Dispatch on arguments

### No args — status and guidance

Read `$DIR/.env` (`$SPRINTABLE_STATE_DIR` if set, else `~/.claude/channels/sprintable`).

1. **Token** — check for `STIBEE_ACCESS_TOKEN`. Show set/not-set; if set, mask (show
   first 6 chars then `…`).
2. **What next**:
   - No token → *"Run `/sprintable:configure-stibee <access-token>`."*
   - Token set → *"Ready. The `publish_stibee_campaign` tool will use it after a session
     restart (or `/reload-plugins`)."*
3. If `SPRINTABLE_API_KEY` itself is not set yet, say so too — `publish_stibee_campaign`
   also needs the Sprintable agent key (for the gate-status chokepoint check), so a Stibee
   token alone is not enough. Point at `/sprintable:configure` for that half.

### `<access-token>` — save

Target dir: same resolution as `/sprintable:configure` (`$SPRINTABLE_STATE_DIR` if set,
else `~/.claude/channels/sprintable`; call it `$DIR`). See that skill's **Multi-agent
isolation** section — it applies identically here (same file, same STATE_DIR).

1. Treat the first token of `$ARGUMENTS` as the AccessToken (trim whitespace).
2. `mkdir -p "$DIR"`
3. **Overwrite guard.** Read the existing `$DIR/.env` if present. If it already has a
   `STIBEE_ACCESS_TOKEN=` whose value differs from the new one, STOP and warn: *"`$DIR/.env`
   already holds a different Stibee token. Overwriting re-points whichever agent uses this
   state dir to a different Stibee workspace."* Ask for explicit confirmation before
   continuing. (Same token = idempotent, no warning.)
4. Update/add `STIBEE_ACCESS_TOKEN=`, preserving every other key already in the file
   (`SPRINTABLE_API_KEY` in particular — never drop it). Write back, no quotes around
   the value.
5. `chmod 600 "$DIR/.env"` — the token is a credential.
6. Confirm (mask the token), then show the no-args status.

### `clear` — remove

Delete the `STIBEE_ACCESS_TOKEN=` line only (never touch `SPRINTABLE_API_KEY=` or other
keys in the same file).

---

## Implementation notes

- The server reads `.env` once at boot — same as `/sprintable:configure`. Credential
  changes need a session restart or `/reload-plugins`. Say so after saving.
- Never echo the full token back to the user — mask it.
- ⛔ Never commit `.env`, never hardcode the token in code (existing repo convention —
  same rule `/sprintable:configure` follows for `SPRINTABLE_API_KEY`).
- Scope note (doc `stibee-publish-connector-wiring-design-3292` §④, PO-confirmed
  2026-09-01): this local-`.env` storage is the M1 design — it scopes the token to
  whichever machine runs the connector (one designated publish agent), not per-org
  server-side secrets. That's a deliberate, PO-approved M1 boundary, not an oversight.
