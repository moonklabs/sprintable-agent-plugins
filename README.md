# Sprintable — agent runtime plugins

Channel plugins that connect coding-agent sessions to a [Sprintable](https://sprintable.ai) team in real time. Three runtimes, one repo:

- **Claude Code** — [`plugins/sprintable`](plugins/sprintable) (this README covers it below).
- **Codex CLI** — [`plugins/sprintable-codex`](plugins/sprintable-codex), installed via `codex plugin marketplace add moonklabs/sprintable-agent-plugins`.
- **Grok Build** — [`plugins/sprintable-grok`](plugins/sprintable-grok), installed via `grok plugin marketplace add moonklabs/sprintable-agent-plugins`.

## Claude Code plugin

A Claude Code **channel plugin** that connects your agent to Sprintable in real time. Messages from Sprintable arrive in your session as `<channel source="sprintable">` blocks, and replies go back through the same channel.

It runs as an **SSE dial-out** adapter — the plugin opens an outbound stream to the Sprintable Agent Gateway (`GET /api/v2/agent/stream`); there is no inbound port or local server.

## Install

```
/plugin marketplace add moonklabs/sprintable-agent-plugins
/plugin install sprintable@moonklabs
/sprintable:configure <your-agent-api-key>
```

Then launch Claude Code with the channel:

```
claude --channels plugin:sprintable@moonklabs
```

- **Agent API key** — Sprintable → Organization → Workforce → your agent → API Keys (shown once).
- `/sprintable:configure` writes the key to `~/.claude/channels/sprintable/.env`. An optional second argument sets the backend URL (defaults to the hosted backend).

## What it does

- Consumes the Sprintable Agent Gateway SSE stream (`GET /api/v2/agent/stream`) outbound and injects chat messages into your session as `<channel source="sprintable">` tags.
- Replies via the `reply` tool → `POST /api/v2/conversations/{id}/messages`.
- An event-type allowlist (`plugins/sprintable/inject-allowlist.ts`) injects only real conversation/work events and drops FYI events.
- Exits cleanly when the host session ends, so it never lingers as an orphan holding a stream slot.

## Requirements

- [Bun](https://bun.sh) — runs the plugin's `server.ts`.
- A Sprintable agent API key.

## Releasing

**Merging a PR is not delivery.** `claude plugin update` (and the Codex/Grok
equivalents) decide whether a fix is "new" purely by comparing the installed
`plugin.json` `version` against the marketplace's. If a merged PR doesn't bump
that version, every installed session — ours and any BYOA marketplace install —
gets "already at the latest version" and never receives the fix. A PR that
changes plugin code without a version bump fails CI
(`.github/workflows/plugin-version-guard.yml`).

To ship a change:

1. **Bump the version** in the plugin's manifest before merging:
   - `plugins/sprintable/.claude-plugin/plugin.json`
   - `plugins/sprintable-codex/.codex-plugin/plugin.json`
   - `plugins/sprintable-grok/plugin.json`
2. **Merge to `main`.**
3. **Verify delivery, don't assume it** — from an installed session:
   ```
   /plugin marketplace update moonklabs
   /plugin update sprintable@moonklabs   # or the codex/grok equivalent
   ```
   then restart the session. Confirm the new version actually loaded before
   calling the release done — a green merge is not a green delivery.
# branch-protection positive-control test, will be closed without merge
