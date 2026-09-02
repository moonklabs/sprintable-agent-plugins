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
  `publish_threads_post` MCP tool. Sent as the `access_token` query parameter on every
  Threads Graph API call — not a header, not OAuth at call time (already-exchanged token).
- `THREADS_USER_ID` — the Threads user id the posts are published as (from
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
   - Both set → *"Ready. The `publish_threads_post` tool will use them after a session
     restart (or `/reload-plugins`)."*
3. If `SPRINTABLE_API_KEY` itself is not set yet, say so too — `publish_threads_post`
   also needs the Sprintable agent key (for the gate-status chokepoint check), so Threads
   credentials alone are not enough. Point at `/sprintable:configure` for that half.

### `<access-token> <user-id> [app-secret]` — save

Target dir: same resolution as `/sprintable:configure` (`$SPRINTABLE_STATE_DIR` if set,
else `~/.claude/channels/sprintable`; call it `$DIR`). See that skill's **Multi-agent
isolation** section — it applies identically here (same file, same STATE_DIR).

1. Split `$ARGUMENTS` on whitespace: first token = access token, second = user id, third
   (optional) = app secret. Trim whitespace on each.
2. If fewer than 2 tokens given, STOP and ask for both `<access-token>` and `<user-id>` —
   the tool cannot address a Threads account without a user id, and a lone token left
   unset would silently break `publish_threads_post` with an unrelated-looking error.
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
7. Confirm (mask the token/secret, show user id in full), then show the no-args status.

### `clear` — remove

Delete the `THREADS_ACCESS_TOKEN=`, `THREADS_USER_ID=`, and `THREADS_APP_SECRET=` lines
only (never touch `SPRINTABLE_API_KEY=`, `STIBEE_ACCESS_TOKEN=`, or other keys in the same
file).

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
