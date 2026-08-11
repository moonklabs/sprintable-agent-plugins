# sprintable-grok (Grok Build plugin)

Connects [Grok Build](https://x.ai/cli) to a [Sprintable](https://sprintable.ai) team — a **channel** (Sprintable messages arrive as `Stop` hook injections, replies post back) plus a **tool** (hosted MCP, no local process).

Ported from `sprintable-codex` (E-CODEX-CHANNEL S2, #2557) — same design (batched Stop-hook injection, `active_conversation` reply routing, seq-cursor dedup on SSE backfill), `GROK_HOME` substituted for `CODEX_HOME`. Grok's hook JSON format and decision vocabulary (`{"decision":"block","reason":...}`) match Claude Code's almost exactly, but **the input envelope is camelCase** (`sessionId`, `stopHookActive`, `lastAssistantMessage`) where Codex/Claude use snake_case — confirmed against Grok's own bundled docs (`~/.grok/docs/user-guide/10-hooks.md`, "Porting Claude Code stop hooks" section), not the public docs.x.ai page (older, narrower).

## Install

```
grok plugin marketplace add moonklabs/sprintable-agent-plugins
grok plugin install sprintable-grok --trust
```

`--trust` is required at install time — without it Grok shows the plugin's source and stops (it activates hooks, MCP servers, and skills, so it asks first). Then configure your key (see below) and run `grok` normally — no extra flags.

### Why configure also patches `$GROK_HOME/hooks/`

On the current grok build (`1.0.0`, confirmed current-stable via `grok update --check`, not an outdated install), a plugin's own `hooks/hooks.json` is discovered as a plugin component — `grok plugin validate` and `grok inspect` both correctly see it — but is **not** merged into the active hook set at session start. Verified with `RUST_LOG=debug GROK_LOG_FILE=<path> grok -p ...`:

```
xai_grok_hooks::discovery: hooks: starting discovery global_sources=4 project_sources=0
xai_grok_hooks::discovery: hooks: loaded from global source source=SettingsFile("$GROK_HOME/hooks") count=0
xai_grok_hooks::discovery: hooks: loaded from global source source=SettingsFile("~/.claude/settings.json") count=0
xai_grok_hooks::discovery: hooks: loaded from global source source=SettingsFile("~/.claude/settings.local.json") count=0
xai_grok_hooks::discovery: hooks: loaded from global source source=SettingsFile("~/.cursor/hooks.json") count=0
```

Plugin-sourced `hooks/hooks.json` never appears among the scanned sources — reproduced both via `grok plugin install --trust` (marketplace) and a plugin placed directly under the auto-trusted `~/.grok/plugins/`, so it isn't an install-path issue. Isolated further: the identical hook JSON, placed directly at `$GROK_HOME/hooks/test.json` (the documented Quick Start location), fires correctly — hook *execution* works fine; only the plugin→discovery link is missing.

Reported upstream via grok's own `/feedback` command (`xai-org/grok-build` has its issue tracker disabled, so this is the only first-party channel).

**Workaround, applied by the `configure` skill itself**: every `/sprintable-grok:configure` call also writes a copy of this plugin's `hooks/hooks.json` (with `${GROK_PLUGIN_ROOT}` resolved to a literal path) to `$GROK_HOME/hooks/sprintable-grok.json`, plus a `sprintable-grok.meta.json` marker noting it's workaround-managed and versioned. `configure clear` removes both files. This keeps the user-facing install story at "2 commands + configure" — no extra step, since configure was already required to set the key. If grok ships a fix, a future plugin revision can detect the meta marker and clean up the redundant global copy; until then, `stop.py`'s reply path is deduplicated per `(session_id, message)` so a session that (for any reason) ends up loading both copies still only replies once.

## Configure

```
/sprintable-grok:configure <agent_api_key> [api_url]
```

**On a machine that also has the Claude Code `sprintable` plugin installed, use
the qualified `/sprintable-grok:configure` form, not the bare
`/sprintable:configure`.** This is a general cross-runtime gotcha, not specific
to this plugin: Grok scans Claude Code's skill directories by default, and any
two plugins that ship a same-named skill (here, both call theirs `configure`)
create an ambiguous bare invocation — Grok may resolve it to the *other*
plugin's skill (confirmed: it wrote to `~/.claude/channels/sprintable/.env`,
the Claude plugin's credential path, not this one's). The qualified
`<plugin-name>:<skill-name>` form is always unambiguous, on Grok or otherwise.

`api_url` is optional — omit it to use the SaaS backend (`https://app.sprintable.ai`); pass it to point at dev or a self-hosted backend instead.

Writes the key to this agent's Sprintable state dir, resolved in order:

1. `$SPRINTABLE_STATE_DIR/.env` — if set, **authoritative**, no fallback.
2. `<project-cwd>/.sprintable/.env` — used if it already exists.
3. `$GROK_HOME/sprintable/.env` — default (`$GROK_HOME` defaults to `~/.grok`).

Running several Sprintable-connected Grok agents on one machine? If each already has its own `GROK_HOME` (the common pattern), isolation is automatic via tier 3 — no extra setup. Only set `SPRINTABLE_STATE_DIR` if agents share a `GROK_HOME`.

**The hosted MCP tool authenticates via a header, not the credential file** — `.mcp.json` declares `"Authorization": "Bearer ${SPRINTABLE_API_KEY}"`, which Grok expands from its own process environment at load time (confirmed against `~/.grok/docs/user-guide/07-mcp-servers.md`'s `${VAR}` expansion docs — this is the standard MCP-config mechanism, not a Codex-style `bearer_token_env_var` shorthand, which Grok's docs never mention). Export `SPRINTABLE_API_KEY` in your launch environment if you want the MCP tool authenticated too; the channel (hooks) works independently of this, same split as the codex plugin.

## How it works

- **Channel**: `SessionStart` hook boots a detached background SSE listener (`GET /api/v2/agent/stream`) that queues inbound messages locally. `Stop` hook checks the queue on every turn boundary; if non-empty, it batches all pending messages into one `{"decision":"block","reason":...}` and Grok processes them as a new turn — no human input required. The same `Stop` hook posts `lastAssistantMessage` back via `POST /api/v2/conversations/{id}/messages`.
- **Tool**: hosted MCP at `https://mcp.sprintable.ai/mcp` (server key `sprintable-mcp`
  in `.mcp.json` — renamed from `sprintable` in #2577; the Claude Code plugin's
  bundled channel MCP is a separate server, historically also named `sprintable`,
  now `sprintable-channel`) — no local process, no clone required.
- Credentials unset → every hook is a safe no-op, channel stays inactive. Existing Grok users see zero behavior change until configured.

## Grok-specific behavior to know

- **8-continuation cap per turn.** Grok forces a turn to end after 8 `Stop`-hook blocks/feedbacks, regardless of decision. This plugin batches the *entire* pending queue into a single `block` per `Stop` fire (not one item at a time), so a burst of queued messages costs one continuation, not N — the cap is rarely relevant in practice.
- **Session-end observe-only `Stop`.** Grok fires an extra `Stop` when a session closes (`reason: "channel_closed"` or `"shutdown"`); its decision is parsed but ignored. This plugin's `stop.py` checks `reason` and skips processing entirely unless it's `"end_turn"`, to avoid a duplicate reply attempt on that fire.
- **`--trust` gate** (see Install above) — the same shape as Codex's hook-trust approval, but granted once at plugin-install time rather than per-session.
- Auxiliary Grok injection surfaces (`monitor` tool, `/loop`, `grok -r <id> -p` resume) were researched but **not implemented here** — investigated in E-AGENT-ONBOARD S5 (#2560), left for a future slice if the team wants them; `Stop` block/reason alone reproduces the codex plugin's proven channel.

## Known follow-up (not blocking)

Same backfill/reconnect edge case as the codex plugin: an SSE reconnect can re-deliver a genuinely-new message tagged `is_backfill=true`. The listener uses a seq-cursor (only drops backfill at or below the last-processed seq) rather than a blanket drop, so this is already hardened per the codex plugin's PR#2 review fix — not a new gap here.
