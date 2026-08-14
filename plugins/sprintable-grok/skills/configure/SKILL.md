---
name: configure
description: Set up the Sprintable channel for Grok Build — save the agent API key. Use when the user pastes a Sprintable agent API key, asks to configure Sprintable, or wants to check channel status.
---

# Sprintable channel setup (Grok Build)

**This skill is for Grok Build** (plugin `sprintable-grok`) — it writes to the
`$GROK_HOME`-anchored state dir below, not `~/.claude/channels/sprintable/.env`
(the Claude Code `sprintable` plugin's separate `configure` skill). If both
plugins are installed, invoke this one by its qualified name,
`/sprintable-grok:configure`, to avoid Grok resolving the bare
`/sprintable:configure` to the other plugin's same-named skill.

Writes `SPRINTABLE_API_KEY` (and optional `SPRINTABLE_API_URL`) to this agent's
credential file, resolved the same way the channel hooks resolve it. If
`SPRINTABLE_API_URL` is omitted, the channel defaults to the SaaS backend
(`https://app.sprintable.ai`) — pass a second argument to point at dev or a
self-hosted backend instead.

1. `$SPRINTABLE_STATE_DIR/.env` — if that env var is set for this session, use it
   and nothing else (explicit isolation; do not fall back elsewhere).
2. `<project-cwd>/.sprintable/.env` — if it already exists, use it.
3. `$GROK_HOME/sprintable/.env` (`$GROK_HOME` defaults to `~/.grok`) — default.

Grok hands `cwd` to every hook and this skill runs in the same session, so
(2)/(3) resolve consistently without extra wiring.

## Multi-agent isolation

Running several Sprintable-connected Grok agents on one machine? If each
already gets its own `GROK_HOME` (the common pattern), isolation is automatic
— tier 3 above already differs per agent. Only set `SPRINTABLE_STATE_DIR`
explicitly if agents share a `GROK_HOME` and still need separate keys.

## Hook activation workaround (grok 1.0.0 plugin-hooks discovery gap)

**Why this step exists**: on the current grok build (`1.0.0`, confirmed current-stable, not outdated), a plugin's own `hooks/hooks.json` is discovered as a plugin component (`grok plugin validate`/`grok inspect` both see it) but is **not** merged into the active hook set at session start — verified with `RUST_LOG=debug`: `xai_grok_hooks::discovery` only scans 4 hardcoded global sources (`$GROK_HOME/hooks/`, `~/.claude/settings.json`, `~/.claude/settings.local.json`, `~/.cursor/hooks.json`) and plugin-sourced hooks never appear among them. An identical hook placed directly under `$GROK_HOME/hooks/` fires correctly — the execution mechanism is fine, only the plugin→discovery link is missing. Reported upstream via `/feedback` (issues are disabled on `xai-org/grok-build`). This step works around it without breaking the "2-command install + one configure call" story — the deploy happens as a side effect of the configure call every user already makes.

This step must run **every time** Save runs (not only on first configure), so re-running `/sprintable-grok:configure` after a plugin upgrade refreshes the workaround copy too.

**story #2658**: this used to be spelled out here as manual steps for the
skill-running agent to follow by hand. It's now `scripts/install_hooks_workaround.py`
(same plugin, one level up from this `skills/configure/` dir) — a standalone
script with no LLM in the loop, so headless/CI/fleet automation that installs
this plugin without ever running this skill can apply the identical workaround
too (see README's "Headless / automation install" section). Run it:

```
python3 <PLUGIN_ROOT>/scripts/install_hooks_workaround.py
```

where `$PLUGIN_ROOT` is this plugin's installed root — the directory containing
this `SKILL.md`, two levels up (`.../sprintable-grok/skills/configure/SKILL.md`
→ `.../sprintable-grok`). It prints the path it wrote on success (exit 0) or a
clear error to stderr and exits non-zero on failure (e.g. source `hooks.json`
missing) — never leaves a half-written/corrupt hooks file behind. Mention in
the confirmation message that this workaround file was (re)written and why
(one line — don't bury it).

The script writes `$GROK_HOME/hooks/sprintable-grok.json` (hooks copy, every
`${GROK_PLUGIN_ROOT}` in a `command` replaced with the literal resolved
`$PLUGIN_ROOT` — the env var is only injected for hooks Grok recognizes as
plugin-sourced, which this copy, now a plain global hook, is not) and
`$GROK_HOME/hooks/sprintable-grok.meta.json` alongside it (`workaround_version`,
`plugin_root`, `updated_at` — lets a future configure run, once grok fixes
native plugin-hook discovery, detect this file and remove itself; check its
presence in a future skill revision before assuming the workaround is still
needed).

Double-firing is safe if a future grok build starts loading the plugin's native `hooks/hooks.json` *in addition to* this workaround copy for the same event: the queue-drain (`stop.py`) is atomic per pop, and `_common.py`'s `post_reply` dedups on `(session_id, message)` before ever sending — a second firing for the same Stop event finds nothing left to send.

## Save

Given `$ARGUMENTS` = `<agent_api_key> [api_url]`:

1. Resolve the target `.env` path per the order above; `mkdir -p` its parent.
2. If that `.env` already has a **different** `SPRINTABLE_API_KEY`, warn before
   overwriting (same warning shape as the codex/Claude Code plugins' configure
   skill) — a shared path means overwriting re-points whatever else reads it.
3. Write `SPRINTABLE_API_KEY=` (and `SPRINTABLE_API_URL=` if given), `chmod 600`.
4. Run the **Hook activation workaround** steps above.
5. Confirm with the key masked (first 6 chars + `…`), and note the workaround
   file was (re)written. Mention that the channel activates on next session
   start — no restart trick needed, hooks re-check credentials every
   `SessionStart`.

## `clear`

Remove `SPRINTABLE_API_KEY=` from the resolved `.env` (or delete the file if
that's the only key left). Also remove `$GROK_HOME/hooks/sprintable-grok.json`
and `$GROK_HOME/hooks/sprintable-grok.meta.json` if present — leaving them
behind would keep injecting into sessions after the user asked to disconnect.

## No args — status

Resolve the path per the order above, report whether a key is set (masked) and
which tier resolved it (override / project-local / GROK_HOME default) — this
tells the user WHY they're isolated or shared without them having to know the
resolution order by heart. Also report whether
`$GROK_HOME/hooks/sprintable-grok.json` exists (the hook activation
workaround) — if the key is set but that file is missing, the channel won't
actually receive messages; re-run Save to fix it.
