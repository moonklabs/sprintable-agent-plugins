#!/usr/bin/env python3
"""Stop hook — 응답 회수(lastAssistantMessage→reply) + 큐 확認→block+reason 주입.

codex(S2, #2557)와 동형 설계(배치 주입·active_conversation 추적) 위에 grok 고유 차이
반영(전부 repo 내장 10-hooks.md 실측, 「Porting Claude Code stop hooks」 절 근거):
  - 입력 camelCase: stopHookActive/lastAssistantMessage/hookEventName(codex는 snake_case).
  - 세션종료 시 관찰용 Stop이 한 번 더 옴(reason: "channel_closed"/"shutdown") — 그 fire의
    decision은 grok이 무시하므로 여기서도 처리 자체를 스킵(중복 회신 방지). reason이 없거나
    "end_turn"일 때만 정상 처리.
  - decision 값은 "block"만(Claude와 동일) — 출력 vocabulary 자체는 안 바뀜.
  - 8-continuation 캡: 큐 전체를 한 reason으로 배치 주입하므로 큐 하나 비우는 데 보통
    continuation 1회면 끝 — 캡에 거의 안 걸림(설계상 완화, codex S1 판정 그대로 계승).
  - 이중발화 내성(PO 가드 ③, hook 활성화 워크어라운드 관련): 같은 Stop 이벤트가 미래에
    두 경로(워크어라운드 global hook + grok이 언젠가 고칠 native plugin hook)로 두 번
    돌아도 — 큐 pop은 원자적이라 두 번째는 빈 큐를 보고, `_common.post_reply`는
    (session_id, 메시지) 조합을 sqlite UNIQUE로 걸어 두 번째 회신 시도를 조용히 버린다.
AC3: 크리덴셜 없으면 이 hook은 전부 조용히 통과 — 예외로 세션 안 깨뜨림.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _credentials import load_credentials  # noqa: E402
from _common import pop_oldest, post_reply, set_active_conversation, get_active_conversation, log_event  # noqa: E402
from envelope import format_envelope_text  # noqa: E402


def _render(item: dict) -> str:
    return format_envelope_text(
        item["content"], sender_name=item.get("sender_name", ""), sender_id=item.get("sender_id", ""),
        sender_type=item.get("sender_type", ""), event_kind=item.get("event_kind", ""),
        ts=item.get("ts", ""), conversation_id=item["conversation_id"],
    )


def main() -> None:
    payload = json.loads(sys.stdin.read() or "{}")
    cwd = payload.get("cwd")
    session_id = payload.get("sessionId")
    last_msg = payload.get("lastAssistantMessage")
    stop_hook_active = bool(payload.get("stopHookActive"))
    reason = payload.get("reason")

    if not load_credentials(cwd).get("SPRINTABLE_API_KEY"):
        return

    if reason and reason != "end_turn":
        log_event(cwd, "stop_skipped_non_turn_end", session_id=session_id, reason=reason)
        return

    log_event(cwd, "stop_fired", session_id=session_id, stop_hook_active=stop_hook_active,
               has_last_message=bool(last_msg))

    if last_msg:
        target = get_active_conversation(cwd)
        if target:
            post_reply(cwd, target, last_msg, session_id=session_id)

    items = []
    while True:
        item = pop_oldest(cwd)
        if item is None:
            break
        items.append(item)

    if not items:
        log_event(cwd, "stop_no_queue", session_id=session_id)
        return

    set_active_conversation(cwd, items[-1]["conversation_id"])
    # story #2583 — 배치 안 각 항목이 자기 발신자를 그대로 유지해 렌더된다.
    if len(items) == 1:
        block_reason = _render(items[0])
    else:
        joined = "\n\n".join(_render(it) for it in items)
        block_reason = f"(밀린 메시지 {len(items)}건)\n{joined}"
    log_event(cwd, "stop_inject", session_id=session_id, batch_size=len(items))
    print(json.dumps({"decision": "block", "reason": block_reason}))


if __name__ == "__main__":
    main()
