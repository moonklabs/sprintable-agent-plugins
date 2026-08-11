# sprintable-codex (Codex CLI plugin)

Connects [Codex CLI](https://github.com/openai/codex) to a [Sprintable](https://sprintable.ai) team — a **channel** (Sprintable messages arrive as `Stop` hook injections, replies post back) plus a **tool** (hosted MCP, no local process).

The channel primitives were verified end-to-end (real message → Codex → real reply, headless and live TUI, isolated test sessions/keys) in E-CODEX-CHANNEL S1 (#2556) — evidence: Sprintable doc `e-codex-channel-s1-spike-raw-evidence`. This package's own 2-command install path (`marketplace add` → `plugin add`, hooks firing from the installed plugin cache, not project-local `.codex/hooks.json`) was separately verified in S2 (#2557) — evidence: Sprintable doc `e-codex-channel-s2-plugin-install-e2e-evidence`.

## Install

```
codex plugin marketplace add moonklabs/sprintable-agent-plugins
codex plugin add sprintable-codex@moonklabs
```

Approve the hook trust prompt once on first run. Then configure your key (see below) and launch `codex` normally — no extra flags.

## Configure

```
/sprintable:configure <agent_api_key> [api_url]
```

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
- **Tool**: hosted MCP at `https://mcp.sprintable.ai/mcp` — no local `stdio`
  process, no clone required.
- Credentials unset → every hook is a safe no-op (`{}`), channel just stays
  inactive. Existing Codex users see zero behavior change until configured.

## Known scope for this package

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
