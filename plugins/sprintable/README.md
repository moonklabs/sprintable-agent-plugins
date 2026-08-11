# sprintable (Claude Code channel)

Pushes Sprintable Agent Gateway events into a Claude Code session and lets Claude reply back — the proper, installable replacement for the hijacked-`fakechat` bridge.

Structure mirrors the shipping official channel plugins (telegram/discord/imessage/fakechat): `plugin.json` is metadata only, `.mcp.json` declares the MCP server, the server declares `experimental['claude/channel']` and reads credentials from `process.env` (loaded from `~/.claude/channels/sprintable/.env`, written by the configure skill). **Not** the plugin.json `channels[].userConfig` schema — no shipping plugin uses that; we build on the proven pattern.

`server.ts` + `inject-allowlist.ts` are the working v0.2.0 SSE adapter, ported verbatim (only the MCP server name and channel `source` changed to `sprintable`). Data flow unchanged:

- **Inbound**: `GET {SPRINTABLE_API_URL}/api/v2/agent/stream` (SSE) → `isInjectableEventType` gate → `notifications/claude/channel` → `<channel source="sprintable" chat_id=<conv> …>`
- **ack**: `POST /api/v2/agent/events/ack {seq}`
- **Outbound (`reply` tool)**: `POST /api/v2/conversations/{id}/messages`

## Install & use

```
/plugin marketplace add moonklabs/sprintable-agent-plugins
/plugin install sprintable@moonklabs
/sprintable:configure <agent_api_key> [api_url]     # writes ~/.claude/channels/sprintable/.env

# Managed org (channelsEnabled + allowedChannelPlugins set) — no dangerous flag:
claude --channels plugin:sprintable@moonklabs
# Pro/Max or non-managed org — dev flag required (flag itself does not trigger refusal):
claude --dangerously-load-development-channels plugin:sprintable@moonklabs
```

Requires [Bun](https://bun.sh). Env: `SPRINTABLE_API_KEY` (or `AGENT_API_KEY`), `SPRINTABLE_API_URL`, optional `HAS_WEBHOOK`.

## Remaining S2 work (build)

1. **`.env` loader** in `server.ts` — port telegram's pattern (load `~/.claude/channels/sprintable/.env` into `process.env`; real env wins).
2. **`/sprintable:configure` skill** (`skills/configure/SKILL.md`) — writes the `.env`. This is the clean credential path that replaces the launcher-env key-injection hack.
3. **Sender gating** — current gate is `event_type` allowlist only; add a `sender.id` allowlist (docs: Gate inbound messages) before external ship.
4. **Local test** — `claude --dangerously-load-development-channels plugin:sprintable@<local>`: confirm channel registers, real SSE events arrive, `reply` round-trips.
5. `inject-allowlist.ts` must stay in sync with backend `connectors/sdk/sprintable_sse.py` `INJECTABLE_EVENT_TYPES`.
