---
name: configure-threads
description: Set up the Threads publish connector — save the Threads access token, user id, and app secret. Use when the user pastes a Threads access token, asks to configure Threads, or asks how to connect Threads for marketing post publishing.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
---

# /sprintable:configure-threads — Threads Publish Connector Setup

**이 명령은 발행 담당 에이전트가 실행합니다** — 사람은 값 3개(`THREADS_ACCESS_TOKEN`·
`THREADS_USER_ID`·`THREADS_APP_SECRET`)만 안전한 경로(1Password 공유 등)로 그 에이전트에게
전달하면 됩니다. 아래 `.env`/`STATE_DIR`은 에이전트가 값을 저장하는 방식에 대한 구현
설명이며, 사람이 직접 건드릴 대상이 아닙니다.

story #3311([M1·마케팅자동화] Threads 발행 커넥터). Writes the Threads credentials to the
**same** channel state dir `/sprintable:configure` already uses — `$SPRINTABLE_STATE_DIR`
if set, otherwise `~/.claude/channels/sprintable` — as `.env`. The channel server (`server.ts`)
loads every `KEY=VALUE` line from that file into `process.env` generically at boot, so no
separate loader is needed for these keys.

Before running this skill, complete the human-hands onboarding procedure — doc
`threads-publish-channel-onboarding` (Meta 앱 생성 → Threads 테스터 계정 등록 → 액세스
토큰 발급; 장기 토큰·User ID는 그 문서 절차대로 **브라우저 주소창에 붙여넣기**로 받습니다
— 터미널 불필요). 저장 흐름은 그 문서 기준으로 **"이 명령 실행 → 3개 값 입력 → 발행
에이전트 env에 저장"** 딱 세 단계입니다.

Arguments passed: `$ARGUMENTS`

The `.env` gains up to three keys:

- `THREADS_ACCESS_TOKEN` — the (long-lived, 60-day) Threads access token, required by the
  `get_threads_insights` MCP tool (measure step, story #3321) and the 250-post/24h
  publishing-limit check it uses. Sent as the `access_token` query parameter on every
  Threads Graph API call — not a header, not OAuth at call time (already-exchanged token).
  **Not used for publishing** — story #3399 removed the direct-publish tool; posting now
  goes through the Sprintable server's own channel connection (OAuth, story #3373),
  unrelated to this local token.
- `THREADS_USER_ID` — the Threads user id whose insights are read (from
  `GET https://graph.threads.net/v1.0/me?fields=id,username&access_token=…`). Required.
- `THREADS_APP_SECRET` — the app's Threads-specific secret, used only to refresh the
  long-lived token before it expires (`GET .../refresh_access_token`). Not read by the
  connector itself today — stored here so it travels with the other two rather than living
  nowhere. Optional but recommended.

---

## Dispatch on arguments

### No args — status and guidance

Read `$DIR/.env` (`$SPRINTABLE_STATE_DIR` if set, else `~/.claude/channels/sprintable`).

1. **Credentials** — check for `THREADS_ACCESS_TOKEN`, `THREADS_USER_ID`,
   `THREADS_APP_SECRET`. Show set/not-set for each; if a token/secret is set, mask (show
   first 6 chars then `…`) — `THREADS_USER_ID` is not a secret, show it in full.
2. **What next**:
   - Missing `THREADS_ACCESS_TOKEN` or `THREADS_USER_ID` → *"Run
     `/sprintable:configure-threads <access-token> <user-id> [app-secret]`."*
   - Both set → *"Ready. `get_threads_insights` will use them after a session restart (or
     `/reload-plugins`). To post to Threads: `list_channel_connections` (find
     connection_id) → `create_channel_post_draft` (write/edit) → `submit_channel_post_draft`
     (send to the external_publish gate) — then a human approves and publishes it from the
     Sprintable screen (story #3399). None of those three tools need the Threads
     credentials here — they call the Sprintable server directly."*
3. If `SPRINTABLE_API_KEY` itself is not set yet, say so too — `get_threads_insights` and
   all three channel-post tools above need the Sprintable agent key, so Threads
   credentials alone are not enough. Point at `/sprintable:configure` for that half.

### `<access-token> <user-id> [app-secret]` — save

Target dir: same resolution as `/sprintable:configure` (`$SPRINTABLE_STATE_DIR` if set,
else `~/.claude/channels/sprintable`; call it `$DIR`). See that skill's **Multi-agent
isolation** section — it applies identically here (same file, same STATE_DIR).

1. Split `$ARGUMENTS` on whitespace: first token = access token, second = user id, third
   (optional) = app secret. Trim whitespace on each.
2. If fewer than 2 tokens given, STOP and ask for both `<access-token>` and `<user-id>` —
   `get_threads_insights` cannot address a Threads account without a user id, and a lone
   token left unset would silently break it with an unrelated-looking error.
3. `mkdir -p "$DIR"`
4. **Overwrite guard.** Read the existing `$DIR/.env` if present. If it already has a
   `THREADS_ACCESS_TOKEN=` or `THREADS_USER_ID=` whose value differs from the new one,
   STOP and warn: *"`$DIR/.env` already holds different Threads credentials. Overwriting
   re-points whichever agent uses this state dir to a different Threads account."* Ask
   for explicit confirmation before continuing. (Same values = idempotent, no warning.)
5. Update/add `THREADS_ACCESS_TOKEN=`, `THREADS_USER_ID=`, and (if given)
   `THREADS_APP_SECRET=`, preserving every other key already in the file
   (`SPRINTABLE_API_KEY`, `STIBEE_ACCESS_TOKEN` in particular — never drop them). Write
   back, no quotes around the values.
6. `chmod 600 "$DIR/.env"` — these are credentials.
7. **Register with the organization's connector registry** (story #3317) — call the
   `register_connector_schema` MCP tool with `{connector: "threads"}`. This uploads the
   content_package schema (which fields are content vs. `org_config`, never a secret value)
   so recipe *apply* can warn about missing org_config before publish ever runs. Idempotent
   — safe even if already registered. If the tool isn't available yet (this session predates
   the plugin version that added it), say so and tell the user a session restart (or
   `/reload-plugins`) picks it up — don't treat a missing tool as a failure to retry loops on.
8. Confirm (mask the token/secret, show user id in full), then show the no-args status.

### `clear` — remove

Delete the `THREADS_ACCESS_TOKEN=`, `THREADS_USER_ID=`, and `THREADS_APP_SECRET=` lines
only (never touch `SPRINTABLE_API_KEY=`, `STIBEE_ACCESS_TOKEN=`, or other keys in the same
file).

---

## Reading error responses from `create_channel_post_draft` / `submit_channel_post_draft`

story #3405 (2026-09-04) — when these two tools fail, the response is a JSON object, not a
plain sentence. Parse it, don't pattern-match the English/Korean text:

```json
{
  "tool": "submit_channel_post_draft",
  "code": "CHANNEL_POST_GATE_ALREADY_HELD",
  "message": "이 work item은 다른 초안이 이미 승인 절차 중입니다(...)",
  "http_status": 409,
  "detail": { "code": "...", "message": "...", "holding_draft_id": "...", "holding_channel": "threads", "holding_connection_id": "..." }
}
```

- **`code`** is the field to branch on, not `message` (message is free-text and may change
  wording). Known codes today: `CHANNEL_CONNECTION_NOT_ACTIVE` (409 — the connection needs
  re-authorizing, see `/sprintable:configure-threads` above), `CHANNEL_TEXT_TOO_LONG` (422 —
  `detail.max_length`/`detail.current_length` tell you exactly how much to trim, no need to
  guess), `CHANNEL_POST_APPROVER_ROLE_MISSING` (409 — an org-config problem, not something a
  retry fixes), `CHANNEL_POST_GATE_ALREADY_HELD` (409, story #3404 — another draft on the
  same work item already holds the approval gate; `detail.holding_draft_id` names it). This
  one won't resolve by retrying either — same result every time as long as that other draft
  holds the gate. The draft named by `detail.holding_draft_id` has to be approved or rejected
  first; surface that id to a human as-is (don't guess which draft it is or resolve it
  yourself).
- **`code` can be `null`** — the server doesn't always attach one (e.g. draft-not-found 404s
  give only a message). Treat `null` the same as an unrecognized code: read `message`, don't
  assume a specific failure mode.
- **An unrecognized `code`** (one not in the list above — the server added something new
  since this skill was last updated) still arrives with its real value and `detail` intact —
  the plugin never relabels it as one of the known codes above. **Stop and surface `code`,
  `message`, and `detail` to a human as-is** — don't treat it as one of the known codes above
  just because it's unfamiliar, and don't decide on your own what it probably means.
- This shape applies to these two tools only (story #3405 scope). Other tools
  (`publish_stibee_campaign` etc.) still return a plain-string error — that's a separate,
  not-yet-fixed gap, tracked outside this story.

---

## Implementation notes

- The server reads `.env` once at boot — same as `/sprintable:configure`. Credential
  changes need a session restart or `/reload-plugins`. Say so after saving.
- Never echo the full token/secret back to the user — mask it. `THREADS_USER_ID` is not
  secret and may be shown in full.
- ⛔ Never commit `.env`, never hardcode any Threads value in code (existing repo
  convention — same rule `/sprintable:configure` and `/sprintable:configure-stibee`
  follow). This connector is a public plugin — no org's account or token may appear in
  code or docs (story #3311 «제품 경계»).
- Scope note (story #3311, M1): this local-`.env` storage scopes the credentials to
  whichever machine runs the connector (one designated publish agent), not per-org
  server-side secrets — the same deliberate M1 boundary `/sprintable:configure-stibee`
  documents for Stibee.
