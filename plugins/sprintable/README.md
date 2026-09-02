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

**Path A — headless (`-p`)**: pass `--permission-prompt-tool mcp__plugin_sprintable_sprintable-channel__approval_prompt` when launching (the `mcp__plugin_<plugin>_<server>__<tool>` prefix is what a real plugin install registers under — confirmed from an actual installed-plugin tool listing; a bare `mcp__sprintable-channel__approval_prompt` only works when the MCP server is loaded ad hoc via `--mcp-config` with server key `sprintable-channel`, e.g. local dev testing, not through a real plugin install). Since this flag must be explicitly given, there's no separate opt-in gate needed — omitting it means the tool is registered but never called (zero behavior change). Verified live against the real MCP tool contract: input is `{tool_name, input, tool_use_id}`; the tool must return `{"behavior":"allow","updatedInput":...}` or `{"behavior":"deny","message":"..."}` as JSON text content.

> **#2577 breaking rename**: this plugin's bundled channel MCP server key changed from `sprintable` to `sprintable-channel` (the separately-configured hosted tools MCP, `https://mcp.sprintable.ai/mcp`, is now `sprintable-mcp`). Same key name on both was causing `/mcp` listing confusion and duplicate-load reports for users who also had the hosted tools MCP configured. If you hardcoded `mcp__plugin_sprintable_sprintable__...` anywhere (e.g. a custom `--permission-prompt-tool` flag or hook), update it to `mcp__plugin_sprintable_sprintable-channel__...`. No other behavior change — the plugin's install name (`sprintable`) and state dir paths (`~/.claude/channels/sprintable`) are unchanged.

**Path B — interactive TUI**: bundled `hooks/hitl_approval_hook.py` on `PreToolUse` (matcher: `Bash|Write|Edit|MultiEdit` by default — tune to taste). Gated behind `SPRINTABLE_HITL_APPROVAL=1` — unset (the default), the hook returns `{}` immediately with zero API calls, zero chat posts, zero behavior change (confirmed live).

Both paths:
- Post the request to the same conversation `reply`/the SSE listener is already routing through (`latestInboundMeta` / `current_conversation.json` — the plugin's existing "active conversation" state, reused rather than inventing a new target-resolution concept), falling back to `SPRINTABLE_HITL_HOME_CHANNEL` if no conversation is active yet.
- Parse a chat reply matching `/^(allow|deny)\b\s*(.*)$/i` as the decision, with the rest of the line as the deny reason.
- **Authority guard**: only `sender.type === "human"` replies count. An agent-sent "allow"/"deny" is logged (`hitl_reply_rejected`) and ignored — otherwise a different agent sharing the same team conversation could approve on the real approver's behalf. Optional `SPRINTABLE_HITL_APPROVERS` (comma-separated member IDs) narrows further; empty (default) means any human.
- **Timeout** (`SPRINTABLE_HITL_TIMEOUT_MS`, default `600000` = 10 min): denies with a message that explicitly says `"챗 승인 타임아웃(무응답)"`, distinct from a genuine human denial — so the model can tell "nobody answered" apart from "someone said no" and choose its next move accordingly (confirmed live: the model correctly explained the timeout to the user rather than treating it as a real refusal, and did not attempt to route around the gate).
- Every request/approval/denial/timeout/rejected-reply is logged to `events.jsonl` in the same state directory as the `.env` (AC3 audit trail).

Env vars: `SPRINTABLE_HITL_APPROVAL` (Path B opt-in), `SPRINTABLE_HITL_HOME_CHANNEL`, `SPRINTABLE_HITL_APPROVERS`, `SPRINTABLE_HITL_TIMEOUT_MS`.

## Marketing publish connector — Stibee (#3292, M1)

`connectors/stibee.ts` — the first "발행 커넥터" (external channel publish connector) in
this repo, built for [M1·마케팅자동화]. Design: doc `stibee-publish-connector-wiring-
design-3292`.

```
/sprintable:configure-stibee <access-token>    # writes STIBEE_ACCESS_TOKEN to the same .env
```

The `publish_stibee_campaign` MCP tool runs a 4-call Stibee v2 sequence — `POST /v2/emails`
(create draft) → `POST /v2/emails/{id}/content` (HTML body, `text/html` raw) → optional
`PUT /v2/emails/{id}` (metadata) → `POST /v2/emails/{id}/send`. **The `send` call is
gated**: `connectors/gate-check.ts::assertGateApproved()` calls `GET /api/v2/gates/{gate_id}`
immediately before it and throws `GateNotApprovedError` unless `gate.status` is `approved`
or `auto_passed` — draft prep (create/content/update) is not gated, only the irreversible
last step. Calling the tool is not itself authorization; the external_publish Gate
(#3689, always-manual regardless of org posture) is the actual chokepoint, re-checked
every call rather than trusted from whatever triggered the call (SSE notification, task
state, etc. — signal, not proof). Pinned with a mutation test (`connectors/stibee.test.ts`):
delete the `assertGateApproved` call and the "send never fires on pending/rejected" tests
go red.

M1 scope: dev/e2e is sandbox or a company test account only — real-account sends are M3,
gated on a separate human approval. Credentials are local-`.env` (same file as
`SPRINTABLE_API_KEY`, PO-confirmed sufficient for the single-workspace M1 dogfood);
server-side per-org secrets are an M2+ concern if/when other orgs BYOA their own Stibee
account.

## Marketing publish connector — Threads (#3311, M1)

`connectors/threads.ts` — the second 발행 커넥터, replacing Stibee as the *first* publish
channel (Stibee's send API is Pro-gated and dogfood has 0 subscribers today, so reach was
0 — see story #3311 background; Stibee stays wired for whenever subscribers exist).

**This connector is not Moonklabs-only.** It is public-plugin shaped: any organization that
installs this plugin, sets its own `THREADS_ACCESS_TOKEN`/`THREADS_USER_ID` in its own
agent's env, and calls `publish_threads_post` gets the same behavior with its own Threads
account — there is no Moonklabs constant anywhere in `connectors/threads.ts`. Moonklabs is
customer-zero, not a hardcoded default. Onboarding (Meta app → Threads tester account →
access token, written to be followable by "the least capable agent") is doc
`threads-publish-channel-onboarding` and mirrored above in `skills/configure-threads/`.

```
/sprintable:configure-threads <access-token> <user-id> [app-secret]   # writes to the same .env
```

The `publish_threads_post` MCP tool runs a 2-call Threads Graph API sequence — `POST
/v1.0/{THREADS_USER_ID}/threads` (create container, `media_type=TEXT`) → `POST
/v1.0/{THREADS_USER_ID}/threads_publish` (`creation_id`) → published post id. **Two
chokepoints** (PR#29 PO AC review — container creation is a real write to Meta, unlike
Stibee's own-system draft prep, so it cannot go out unapproved either):
`connectors/gate-check.ts::assertGateApproved()` runs (1) immediately on entry, before the
rate-limit lookup or container creation — zero outbound calls to Meta while the gate isn't
`approved`/`auto_passed` — and (2) again immediately before `threads_publish`, re-checking
in case approval was revoked between (1) and (2). No new gate logic — same function Stibee
uses, called twice. Pinned with two independent mutation tests
(`connectors/threads.test.ts`, verified locally by deleting each `assertGateApproved` call
in turn and confirming only its own tests go red, then restoring): removing chokepoint ①
turns the "zero outbound while pending/rejected" tests red; removing chokepoint ② turns the
race-defense test red without touching the others.

Also checked before posting: text length (500-char cap, explicit error over the limit) and
the 250-post/24h Threads publishing limit (`GET .../threads_publishing_limit`, explicit
error if exhausted — no silent drop, no automatic retry). `threadsGetInsights()` (views/
likes/replies/reposts/quotes) is implemented and tested for the M3 measure step but not
called from the publish path yet.

M1 scope: dev is a mock-server dry run (`bun test`) plus explicit errors when
`THREADS_ACCESS_TOKEN`/`THREADS_USER_ID` are unset — no silent no-op. Real-account posting
(a company-owned Threads account in Meta's developer mode as a registered tester) is a
separate, explicitly confirmed step once credentials exist; real sends beyond that are M3,
gated on human approval same as Stibee.

### Gate resolution without a gate_id (#3312 AC5)

Both `publish_stibee_campaign` and `publish_threads_post` accept `gate_id` explicitly, or
`work_item` (+ optional `work_item_type`, default `story`) instead — for the recipe
automation loop, which doesn't know a gate id up front, only the work item its approve
stage just gated. `connectors/gate-check.ts::assertGateApprovedForWorkItem()` resolves it:
`GET /api/v2/gates?work_item_id=&work_item_type=&gate_type=external_publish&limit=1`
(no new route — existing endpoint, contract confirmed against backend PR#3704 "커넥터용
조회 계약" and the actual `list_gates` source; `limit=1` is required to get
`created_at desc` ordering at all — story #2864's fix only sorts when `limit`/`offset` is
present, so a bare filtered query is unordered). Zero results means the approve stage
hasn't created a gate yet — `NoGateFoundError`, distinct from `GateNotApprovedError`
(gate exists, just not approved). `gate_id` wins when both are given. Same two-round-trip
savings as the explicit path: the list response already carries `status`, so no follow-up
`GET /api/v2/gates/{id}` call is needed.

Applying this (or any) recipe to a project happens in **프로젝트 설정 → 워크플로우
갤러리**, not from the event-definition catalog (`/organization/events`) itself — that
gallery→apply gap for non-developer users is tracked separately in story #3316.

## Remaining S2 work (build)

1. **`.env` loader** in `server.ts` — port telegram's pattern (load `~/.claude/channels/sprintable/.env` into `process.env`; real env wins).
2. **`/sprintable:configure` skill** (`skills/configure/SKILL.md`) — writes the `.env`. This is the clean credential path that replaces the launcher-env key-injection hack.
3. **Sender gating** — current gate is `event_type` allowlist only; add a `sender.id` allowlist (docs: Gate inbound messages) before external ship.
4. **Local test** — `claude --dangerously-load-development-channels plugin:sprintable@<local>`: confirm channel registers, real SSE events arrive, `reply` round-trips.
5. `inject-allowlist.ts` must stay in sync with backend `connectors/sdk/sprintable_sse.py` `INJECTABLE_EVENT_TYPES`.
