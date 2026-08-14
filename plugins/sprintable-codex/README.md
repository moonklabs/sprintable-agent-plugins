# sprintable-codex (Codex CLI plugin)

Connects [Codex CLI](https://github.com/openai/codex) to a [Sprintable](https://sprintable.ai) team — a **channel** (Sprintable messages arrive as `Stop` hook injections, replies post back) plus a **tool** (hosted MCP, no local process).

The channel primitives were verified end-to-end (real message → Codex → real reply, headless and live TUI, isolated test sessions/keys) in E-CODEX-CHANNEL S1 (#2556) — evidence: Sprintable doc `e-codex-channel-s1-spike-raw-evidence`. This package's own 2-command install path (`marketplace add` → `plugin add`, hooks firing from the installed plugin cache, not project-local `.codex/hooks.json`) was separately verified in S2 (#2557) — evidence: Sprintable doc `e-codex-channel-s2-plugin-install-e2e-evidence`.

## Install

```
codex plugin marketplace add moonklabs/sprintable-agent-plugins
codex plugin add sprintable-codex@moonklabs
```

**Required one-time step — trust this plugin's hooks**: installing/enabling a
plugin does **not** auto-trust its bundled hooks (codex CLI's own security
model, confirmed against `codex` 0.147.0 — story #2656). Codex silently skips
any hook it hasn't hash-reviewed: the session still completes, no error is
printed, no `SessionStart`/`Stop` hook line appears anywhere in the output —
so a fresh install that skips this step *looks* fine and just never delivers
any Sprintable messages. Run `/hooks` once in the interactive TUI after
installing, review the `sprintable-codex` hooks, and trust them. This is a
one-time step per `CODEX_HOME` — after that, launch `codex` normally with no
extra flags.

(Automation that boots `codex exec` headlessly, e.g. CI or a fleet
orchestrator that already vets this plugin's source out-of-band, can pass
`--dangerously-bypass-hook-trust` instead of the interactive step above — see
`codex exec --help`. Don't reach for this as a way around trusting the plugin
yourself; it's documented by Codex as an automation-only escape hatch.)

## Configure

```
/sprintable:configure <agent_api_key> [api_url]
```

`api_url` is optional — omit it to use the SaaS backend (`https://app.sprintable.ai`);
pass it to point at dev or a self-hosted backend instead.

Writes the key to this agent's Sprintable state dir, resolved in order:

1. `$SPRINTABLE_STATE_DIR/.env` — if set, **authoritative**, no fallback.
2. `<project-cwd>/.sprintable/.env` — used if it already exists.
3. `$CODEX_HOME/sprintable/.env` — default (`$CODEX_HOME` defaults to `~/.codex`).

Running several Sprintable-connected Codex agents on one machine? If each already
has its own `CODEX_HOME` (the common pattern), isolation is automatic via tier 3 —
no extra setup. Only set `SPRINTABLE_STATE_DIR` if agents share a `CODEX_HOME`.

**The hosted MCP tool needs its own auth separately** — `bearer_token_env_var` in
`.mcp.json` reads `SPRINTABLE_API_KEY` from Codex's own process environment, not
from the `.env` file (the file only feeds this plugin's hook scripts). Export
`SPRINTABLE_API_KEY` in your launch environment if you want the MCP tool
authenticated too; the channel (hooks) works independently of this.

## How it works

- **Channel**: `SessionStart` hook boots a detached background SSE listener
  (`GET /api/v2/agent/stream`) that queues inbound messages locally. `Stop` hook
  checks the queue on every turn boundary; if non-empty, it batches all pending
  messages into one `{"decision":"block","reason":...}` and Codex processes them
  as a new turn — no human input required. The same `Stop` hook posts
  `last_assistant_message` back via `POST /api/v2/conversations/{id}/messages`.
- **Tool**: hosted MCP at `https://mcp.sprintable.ai/mcp` (server key
  `sprintable-mcp` in `.mcp.json` — renamed from `sprintable` in #2577 to
  avoid colliding with the Claude Code plugin's bundled channel MCP, which is
  a separate server also historically named `sprintable`) — no local `stdio`
  process, no clone required.
- Credentials unset → every hook is a safe no-op (`{}`), channel just stays
  inactive. Existing Codex users see zero behavior change until configured.

## Known scope for this package

- **Untrusted hooks are undetectable from inside this plugin (story #2656).**
  If the one-time `/hooks` trust step above is skipped, Codex skips this
  plugin's `SessionStart`/`UserPromptSubmit`/`Stop` hooks entirely — none of
  our scripts ever run, so they can't log or signal anything, and Codex itself
  prints zero hook-related output either way. A session that "completes fine"
  is not evidence the channel is active. To verify it actually is, check for a
  `session_start` line in `$CODEX_HOME/sprintable/events.jsonl` (or the
  project-local state dir, per Configure above) after a session — its absence
  means hooks aren't trusted yet, not that something crashed.
- Injection primitive used here is `Stop` block/reason only. `codex exec resume`
  against an already-open interactive session is **not viable** — S1 measured it
  failing unconditionally (`thread-store conflict: ... already has an active
  writer`, even idle) — so it's left for a future "wake a session that isn't
  running yet" scenario, out of scope here.
- SSE reconnects can re-deliver events tagged `is_backfill=true`, including ones
  the listener never actually processed before the reconnect. The listener
  tracks a last-processed-seq cursor (`seq_cursor.json` in the state dir):
  `is_backfill` events at or below the cursor are true replays and get dropped;
  events above the cursor are enqueued even if flagged `is_backfill`, so a
  message that arrives during a reconnect window isn't silently lost.
