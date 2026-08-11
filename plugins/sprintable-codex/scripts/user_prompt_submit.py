#!/usr/bin/env python3
"""UserPromptSubmit hook — additionalContext 피기백(S1 실증 프리미티브 #3).

S1 판정: 이 채널은 사람이 실제로 뭔가 칠 때만 도달하는 보조 경로라, 주 전달은 여전히
Stop block/reason(stop.py)이 담당한다. 여기선 "밀린 큐가 있다"만 살짝 얹어 모델이
다음 Stop에서 배치 주입될 것을 미리 인지하게 하는 정도로 최소화.
AC2: 크리덴셜 없으면 항상 {} — 예외 없음.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _credentials import load_credentials  # noqa: E402
from _common import queue_depth, log_event  # noqa: E402


def main() -> None:
    payload = json.loads(sys.stdin.read() or "{}")
    cwd = payload.get("cwd")

    if not load_credentials(cwd).get("SPRINTABLE_API_KEY"):
        print(json.dumps({}))
        return

    depth = queue_depth(cwd)
    log_event(cwd, "user_prompt_submit", session_id=payload.get("session_id"), queue_depth=depth)

    if depth == 0:
        print(json.dumps({}))
        return

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": f"[Sprintable: {depth}건의 팀 메시지가 대기 중 — 이 턴 뒤 자동 전달됨]",
        }
    }))


if __name__ == "__main__":
    main()
