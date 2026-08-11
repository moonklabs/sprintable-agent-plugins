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

## HITL① — permission 승인을 Sprintable 챗으로 (#2570, opt-in)

Claude Code's permission prompt (allow/deny a risky tool call) can be relayed to Sprintable chat instead of blocking on a local terminal. Two independent paths, both **default OFF**:

**Path A — headless (`-p`)**: pass `--permission-prompt-tool mcp__sprintable__approval_prompt` when launching. Since this flag must be explicitly given, there's no separate opt-in gate needed — omitting it means the tool is registered but never called (zero behavior change). Verified live against the real MCP tool contract: input is `{tool_name, input, tool_use_id}`; the tool must return `{"behavior":"allow","updatedInput":...}` or `{"behavior":"deny","message":"..."}` as JSON text content.

**Path B — interactive TUI**: bundled `hooks/hitl_approval_hook.py` on `PreToolUse` (matcher: `Bash|Write|Edit|MultiEdit` by default — tune to taste). Gated behind `SPRINTABLE_HITL_APPROVAL=1` — unset (the default), the hook returns `{}` immediately with zero API calls, zero chat posts, zero behavior change (confirmed live).

Both paths:
- Post the request to the same conversation `reply`/the SSE listener is already routing through (`latestInboundMeta` / `current_conversation.json` — the plugin's existing "active conversation" state, reused rather than inventing a new target-resolution concept), falling back to `SPRINTABLE_HITL_HOME_CHANNEL` if no conversation is active yet.
- Parse a chat reply matching `/^(allow|deny)\b\s*(.*)$/i` as the decision, with the rest of the line as the deny reason.
- **Authority guard**: only `sender.type === "human"` replies count. An agent-sent "allow"/"deny" is logged (`hitl_reply_rejected`) and ignored — otherwise a different agent sharing the same team conversation could approve on the real approver's behalf. Optional `SPRINTABLE_HITL_APPROVERS` (comma-separated member IDs) narrows further; empty (default) means any human.
- **Timeout** (`SPRINTABLE_HITL_TIMEOUT_MS`, default `600000` = 10 min): denies with a message that explicitly says `"챗 승인 타임아웃(무응답)"`, distinct from a genuine human denial — so the model can tell "nobody answered" apart from "someone said no" and choose its next move accordingly (confirmed live: the model correctly explained the timeout to the user rather than treating it as a real refusal, and did not attempt to route around the gate).
- Every request/approval/denial/timeout/rejected-reply is logged to `events.jsonl` in the same state directory as the `.env` (AC3 audit trail).

Env vars: `SPRINTABLE_HITL_APPROVAL` (Path B opt-in), `SPRINTABLE_HITL_HOME_CHANNEL`, `SPRINTABLE_HITL_APPROVERS`, `SPRINTABLE_HITL_TIMEOUT_MS`.

## Remaining S2 work (build)

1. **`.env` loader** in `server.ts` — port telegram's pattern (load `~/.claude/channels/sprintable/.env` into `process.env`; real env wins).
2. **`/sprintable:configure` skill** (`skills/configure/SKILL.md`) — writes the `.env`. This is the clean credential path that replaces the launcher-env key-injection hack.
3. **Sender gating** — current gate is `event_type` allowlist only; add a `sender.id` allowlist (docs: Gate inbound messages) before external ship.
4. **Local test** — `claude --dangerously-load-development-channels plugin:sprintable@<local>`: confirm channel registers, real SSE events arrive, `reply` round-trips.
5. `inject-allowlist.ts` must stay in sync with backend `connectors/sdk/sprintable_sse.py` `INJECTABLE_EVENT_TYPES`.
