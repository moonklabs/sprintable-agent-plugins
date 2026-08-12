#!/usr/bin/env python3
"""UserPromptSubmit hook — additionalContext 피기백(best-effort, 보조 채널).

grok 문서는 UserPromptSubmit을 non-blocking으로만 명시하고 output 스키마를 별도
예시하지 않음 — Stop 훅과 동일한 hookSpecificOutput.additionalContext 관례(Claude
호환 문서화 근거)를 그대로 적용. 인식 안 되면 무해하게 무시될 뿐(codex S1 판정과
동일하게 이 채널은 어차피 보조일 뿐, 주 전달은 stop.py).
AC3: 크리덴셜 없으면 항상 무출력.
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
        return

    depth = queue_depth(cwd)
    log_event(cwd, "user_prompt_submit", session_id=payload.get("sessionId"), queue_depth=depth)

    if depth == 0:
        return

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": f"[Sprintable: {depth}건의 팀 메시지가 대기 중 — 이 턴 뒤 자동 전달됨]",
        }
    }))


if __name__ == "__main__":
    main()
