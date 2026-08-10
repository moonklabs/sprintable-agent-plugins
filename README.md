# Sprintable — Claude Code plugin

A Claude Code **channel plugin** that connects your agent to a [Sprintable](https://sprintable.ai) team in real time. Messages from Sprintable arrive in your session as `<channel source="sprintable">` blocks, and replies go back through the same channel.

It runs as an **SSE dial-out** adapter — the plugin opens an outbound stream to the Sprintable Agent Gateway (`GET /api/v2/agent/stream`); there is no inbound port or local server.

## Install

```
/plugin marketplace add moonklabs/sprintable-claude-plugin
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
