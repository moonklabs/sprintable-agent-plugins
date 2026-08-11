#!/usr/bin/env python3
"""SessionStart hook — 크리덴셜 있으면 백그라운드 SSE 리스너 detach 부트.

AC2: 크리덴셜 미설정이면 아무 것도 안 하고 {} 반환(에러 없음·세션 안 깨뜨림).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
from _credentials import load_credentials  # noqa: E402
from _common import _state_dir, log_event, set_current_session  # noqa: E402


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def ensure_listener_running(cwd: str | None) -> None:
    state_dir = _state_dir(cwd)
    pid_file = state_dir / "listener.pid"
    if pid_file.exists():
        try:
            existing = int(pid_file.read_text().strip())
        except ValueError:
            existing = -1
        if existing > 0 and _pid_alive(existing):
            log_event(cwd, "listener_already_running", pid=existing)
            return
    log_fh = open(state_dir / "listener.log", "a")
    uv = shutil.which("uv")
    # httpx는 시스템 python엔 없는 게 보통 — uv 있으면 `uv run --with httpx`로 격리 실행(설치 스텝
    # 추가 없이 AC1의 "2명령" 유지). uv 없으면 시스템 python3로 시도하되 listener.py 자체가
    # httpx ImportError를 잡아 조용히 종료(AC2 — 세션은 절대 안 깨뜨림, 채널만 비활성).
    if uv:
        cmd = [uv, "run", "--with", "httpx", "python3", str(SCRIPT_DIR / "listener.py"), "--cwd", cwd or ""]
    else:
        cmd = [sys.executable, str(SCRIPT_DIR / "listener.py"), "--cwd", cwd or ""]
    proc = subprocess.Popen(
        cmd, stdout=log_fh, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
        start_new_session=True, cwd=str(SCRIPT_DIR),
    )
    pid_file.write_text(str(proc.pid))
    log_event(cwd, "listener_spawned", pid=proc.pid, via_uv=bool(uv))


def main() -> None:
    payload = json.loads(sys.stdin.read() or "{}")
    cwd = payload.get("cwd")
    creds = load_credentials(cwd)
    if creds.get("SPRINTABLE_API_KEY"):
        session_id = payload.get("session_id")
        log_event(cwd, "session_start", session_id=session_id, source=payload.get("source"))
        if session_id:
            set_current_session(cwd, session_id, cwd)
        ensure_listener_running(cwd)
    print(json.dumps({}))


if __name__ == "__main__":
    main()
