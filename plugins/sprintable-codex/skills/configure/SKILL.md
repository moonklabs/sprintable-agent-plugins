---
name: configure
description: Set up the Sprintable channel for Codex — save the agent API key. Use when the user pastes a Sprintable agent API key, asks to configure Sprintable, or wants to check channel status.
---

# Sprintable channel setup (Codex)

Writes `SPRINTABLE_API_KEY` (and optional `SPRINTABLE_API_URL`) to this agent's
credential file, resolved the same way the channel hooks resolve it:

1. `$SPRINTABLE_STATE_DIR/.env` — if that env var is set for this session, use it
   and nothing else (explicit isolation; do not fall back elsewhere).
2. `<project-cwd>/.sprintable/.env` — if it already exists, use it.
3. `$CODEX_HOME/sprintable/.env` (`$CODEX_HOME` defaults to `~/.codex`) — default.

Codex hands `cwd` to every hook and this skill runs in the same session, so
(2)/(3) resolve consistently without extra wiring — no separate "server sees a
different path than the skill" problem.

## Multi-agent isolation

Running several Sprintable-connected Codex agents on one machine? If each
already gets its own `CODEX_HOME` (the common pattern), isolation is automatic
— tier 3 above already differs per agent. Only set `SPRINTABLE_STATE_DIR`
explicitly if agents share a `CODEX_HOME` and still need separate keys.

## Save

Given `$ARGUMENTS` = `<agent_api_key> [api_url]`:

1. Resolve the target `.env` path per the order above; `mkdir -p` its parent.
2. If that `.env` already has a **different** `SPRINTABLE_API_KEY`, warn before
   overwriting (same warning shape as the Claude Code plugin's configure skill)
   — a shared path means overwriting re-points whatever else reads it.
3. Write `SPRINTABLE_API_KEY=` (and `SPRINTABLE_API_URL=` if given), `chmod 600`.
4. Confirm with the key masked (first 6 chars + `…`). Mention that the channel
   activates on next session start — no restart trick needed, hooks re-check
   credentials every `SessionStart`.

## `clear`

Remove `SPRINTABLE_API_KEY=` from the resolved `.env` (or delete the file if
that's the only key left).

## No args — status

Resolve the path per the order above, report whether a key is set (masked) and
which tier resolved it (override / project-local / CODEX_HOME default) — this
tells the user WHY they're isolated or shared without them having to know the
resolution order by heart.
