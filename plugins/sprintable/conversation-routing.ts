/**
 * story #2589 fix — per-worker isolation for the `current_conversation.json`
 * routing signal that `hooks/hitl_approval_hook.py` (Path B, a separate
 * subprocess) reads to find where to post an approval card.
 *
 * ENV_FILE/STATE_DIR (credentials) in server.ts keep their existing 3-candidate
 * resolution unchanged (out of scope here, working as documented) — but
 * `current_conversation.json` must not be shared across two workers even when
 * STATE_DIR falls through to the shared homedir default, because unlike
 * credentials (guarded by "first candidate whose .env actually exists"), this
 * file has no such guard: every server.ts process unconditionally overwrites
 * it on inbound. Two fleet workers sharing the (undocumented-but-real, since
 * no worker sets SPRINTABLE_STATE_DIR or has a project-local .sprintable/.env
 * today) homedir default silently clobber each other's routing signal — a
 * worker's approval card can post into a DIFFERENT worker's conversation.
 * Reproduced directly against the unmodified hook in story #2589.
 *
 * Fix: suffix the filename with a sanitized CLAUDE_PROJECT_DIR — the one
 * signal both this process and the PreToolUse hook subprocess (spawned in the
 * same Claude Code session) independently see, so both sides derive the
 * identical suffix with zero inter-process coordination.
 *
 * ⚠️ 언어 경계(Python ↔ TS) — 이 로직은 `hooks/hitl_approval_hook.py`의
 * `_conversation_routing_suffix()`와 **문자 단위로 동일**해야 한다. 일부러
 * 해시가 아니라 단순 문자 치환을 쓴 이유: 해시 알고리즘은 두 언어 구현이 조용히
 * 갈릴 수 있지만(#2589가 고치려는 병 그 자체의 재발), 문자 치환은 갈릴 수 없다.
 * 이 파일과 그 파이썬 파일을 함께 바꾸지 않으면 두 프로세스가 다른 파일명을
 * 계산해 다시 서로를 못 찾는다 — 각자의 픽스된 테스트가 그 드리프트를 잡는다.
 */
export function conversationRoutingSuffix(): string {
  const dir = process.env.CLAUDE_PROJECT_DIR
  if (!dir) return '' // CLAUDE_PROJECT_DIR 미설정 — 레거시 공유 파일명으로 폴백
  return '.' + dir.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function currentConversationFilename(): string {
  return `current_conversation${conversationRoutingSuffix()}.json`
}
