#!/usr/bin/env python3
"""Stop hook — 응답 회수(last_assistant_message→reply) + 큐 확認→block+reason 주입.

S1(#2556) 실측 판정 반영:
  - exec resume은 락-프리(헤드리스) 세션 전용, 라이브 세션 주입은 이 경로가 유일 —
    그래서 여기서 큐 여러 건이 쌓였으면 1건씩 draining 말고 합쳐서 한 reason으로 주입
    (턴당 고정 토큰비용을 다건에 걸쳐 상쇄, S1 AC3 판정).
  - stop_hook_active는 무한루프 가드로 존재하지만 우리는 "큐에 실제 내용이 있을 때만"
    block 하므로 always-terminating — active=true인 2차 Stop도 정상 드레인 경로.
AC2: 크리덴셜 없으면 이 hook은 전부 조용히 {} — 예외로 세션 안 깨뜨림.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _credentials import load_credentials  # noqa: E402
from _common import pop_oldest, post_reply, set_active_conversation, get_active_conversation, log_event  # noqa: E402


def main() -> None:
    payload = json.loads(sys.stdin.read() or "{}")
    cwd = payload.get("cwd")
    session_id = payload.get("session_id")
    last_msg = payload.get("last_assistant_message")
    stop_hook_active = bool(payload.get("stop_hook_active"))

    if not load_credentials(cwd).get("SPRINTABLE_API_KEY"):
        print(json.dumps({}))
        return

    log_event(cwd, "stop_fired", session_id=session_id, stop_hook_active=stop_hook_active,
               has_last_message=bool(last_msg))

    if last_msg:
        target = get_active_conversation(cwd)
        if target:
            post_reply(cwd, target, last_msg)

    # 큐에 쌓인 것 전부 하나의 reason으로 합쳐 주입 — draining 1건씩 하지 않음(S1 AC3 판정).
    items = []
    while True:
        item = pop_oldest(cwd)
        if item is None:
            break
        items.append(item)

    if not items:
        log_event(cwd, "stop_no_queue", session_id=session_id)
        print(json.dumps({}))
        return

    set_active_conversation(cwd, items[-1]["conversation_id"])
    if len(items) == 1:
        reason = items[0]["content"]
    else:
        joined = "\n\n".join(f"- {it['content']}" for it in items)
        reason = f"(밀린 메시지 {len(items)}건)\n{joined}"
    log_event(cwd, "stop_inject", session_id=session_id, batch_size=len(items))
    print(json.dumps({"decision": "block", "reason": reason}))


if __name__ == "__main__":
    main()
