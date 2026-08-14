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

**Workaround**: `scripts/install_hooks_workaround.py` writes a copy of this
plugin's `hooks/hooks.json` (with `${GROK_PLUGIN_ROOT}` resolved to a literal
path) to `$GROK_HOME/hooks/sprintable-grok.json`, plus a
`sprintable-grok.meta.json` marker noting it's workaround-managed and
versioned. The `configure` skill runs it as a side effect of every
`/sprintable-grok:configure` call (interactive users get it for free — no
extra step, since configure was already required to set the key); `configure
clear` removes both files. If grok ships a fix, a future plugin revision can
detect the meta marker and clean up the redundant global copy; until then,
`stop.py`'s reply path is deduplicated per `(session_id, message)` so a
session that (for any reason) ends up loading both copies still only replies
once.

### Headless / automation install (story #2658)

The `configure` skill only runs inside an LLM-driven Grok session (it's a
slash command) — automation that does `grok plugin install ...` and then
drives sessions without ever invoking `/sprintable-grok:configure` (writing
`SPRINTABLE_API_KEY` straight to `.env` instead, say) never triggers the
workaround above, so its hooks stay permanently unregistered even though the
plugin looks correctly installed (`grok plugin list`/`details` show it fine —
`has_hooks=true` at the discovery-scanner layer, `total_hooks=0` at the
actual hook-merge layer). This is what tripped up the clone-zero
verification rig, not a separate bug from the one above.

Run the same workaround as a plain script, no LLM/skill needed:

```
grok plugin install moonklabs/sprintable-agent-plugins#plugins/sprintable-grok --trust
grok plugin details sprintable-grok   # prints "path:" and "(subdir: plugins/sprintable-grok)"
python3 <path>/plugins/sprintable-grok/scripts/install_hooks_workaround.py
```

`grok plugin details` has no `--json` output (checked `grok plugin details
--help` — text only) — read the `path:` line and the `(subdir: ...)` suffix
from its plain output and join them yourself, or just hardcode the path your
own install step already used (automation that ran `grok plugin install`
itself already knows where it put the plugin). Re-run the script after every
plugin upgrade, same as interactive users get from re-running `configure`.

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
- **Free-tier "Grok Build" usage window is narrow — thinner than a day, not just "hits eventually."** Live-verified 2026-08-12: the CLI's own error is `"You've reached your free Grok Build usage limit for now. Get SuperGrok for much higher limits, or try again later"` — phrasing that reads as a resettable rate limit, not a hard credit wall (confirmed: it *did* reset overnight). But the reset is not generous — one successful generation was immediately followed by the same block again ~5-6 minutes later on a fresh, single-item continuation. This plugin's channel mechanism (SSE → queue → `Stop`-hook injection → reply) worked correctly end-to-end up through the API call boundary in that test; the block happens inside Grok's own model call, outside this plugin's control — same category of boundary as any other free-tier LLM provider limit (OpenAI/Gemini/etc.), just with a noticeably thinner refill than "once per day." **If you're on the free tier, expect Sprintable-triggered continuations to compete with your own interactive usage for the same thin budget** — `SuperGrok` (paid) is the documented way around this, not a plugin-side fix.

## Known follow-up (not blocking)

Same backfill/reconnect edge case as the codex plugin: an SSE reconnect can re-deliver a genuinely-new message tagged `is_backfill=true`. The listener uses a seq-cursor (only drops backfill at or below the last-processed seq) rather than a blanket drop, so this is already hardened per the codex plugin's PR#2 review fix — not a new gap here.
