"""Sprintable codex plugin — shared queue/state helpers.

S1 스파이크(#2556) 실측 위에서 프로덕션화. 스파이크 대비 바뀐 점:
  - 크리덴셜/상태 경로가 고정 단일 conv이 아니라 _credentials 체인으로 해석됨.
  - 회신 대상 conversation_id를 큐 row가 아니라 "세션의 active conversation"으로 추적
    (사용자 자체 턴에 대한 응답도 회신해야 하므로 — 큐 항목에만 달려있으면 못 잡음).
  - AC2: 크리덴셜 미설정이면 모든 함수가 조용히 no-op(예외 없이) — 세션을 절대 안 깨뜨림.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
import urllib.request
from pathlib import Path

from _credentials import load_credentials, resolve_env_file


def _state_dir(cwd: str | None) -> Path:
    d = resolve_env_file(cwd).parent
    d.mkdir(parents=True, exist_ok=True)
    return d


def log_event(cwd: str | None, kind: str, **fields) -> None:
    events_file = _state_dir(cwd) / "events.jsonl"
    with open(events_file, "a") as f:
        f.write(json.dumps({"ts": time.time(), "kind": kind, **fields}, ensure_ascii=False) + "\n")


def _conn(cwd: str | None) -> sqlite3.Connection:
    conn = sqlite3.connect(str(_state_dir(cwd) / "queue.sqlite"), timeout=10)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS queue ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, "
        "conversation_id TEXT, created_at REAL NOT NULL)"
    )
    return conn


def enqueue(cwd: str | None, content: str, conversation_id: str) -> int:
    conn = _conn(cwd)
    try:
        cur = conn.execute(
            "INSERT INTO queue (content, conversation_id, created_at) VALUES (?, ?, ?)",
            (content, conversation_id, time.time()),
        )
        conn.commit()
        log_event(cwd, "enqueued", row_id=cur.lastrowid, conversation_id=conversation_id)
        return cur.lastrowid
    finally:
        conn.close()


def pop_oldest(cwd: str | None) -> dict | None:
    conn = _conn(cwd)
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT id, content, conversation_id, created_at FROM queue ORDER BY id ASC LIMIT 1"
        ).fetchone()
        if row is None:
            conn.execute("COMMIT")
            return None
        conn.execute("DELETE FROM queue WHERE id = ?", (row[0],))
        conn.commit()
        item = {"id": row[0], "content": row[1], "conversation_id": row[2], "created_at": row[3]}
        log_event(cwd, "popped", row_id=row[0], enqueued_at=row[3])
        return item
    finally:
        conn.close()


def queue_depth(cwd: str | None) -> int:
    conn = _conn(cwd)
    try:
        return conn.execute("SELECT COUNT(*) FROM queue").fetchone()[0]
    finally:
        conn.close()


def get_seq_cursor(cwd: str | None) -> int:
    """마지막으로 처리한 이벤트 seq(단조증가, 키당 전역). 재연결 backfill 판정 기준."""
    f = _state_dir(cwd) / "seq_cursor.json"
    if not f.exists():
        return 0
    try:
        return int(json.loads(f.read_text()).get("seq", 0))
    except (json.JSONDecodeError, OSError, ValueError):
        return 0


def advance_seq_cursor(cwd: str | None, seq: int) -> None:
    if seq <= 0:
        return
    current = get_seq_cursor(cwd)
    if seq > current:
        (_state_dir(cwd) / "seq_cursor.json").write_text(json.dumps({"seq": seq, "updated_at": time.time()}))


def set_active_conversation(cwd: str | None, conversation_id: str) -> None:
    (_state_dir(cwd) / "active_conversation.json").write_text(
        json.dumps({"conversation_id": conversation_id, "updated_at": time.time()})
    )


def get_active_conversation(cwd: str | None) -> str | None:
    f = _state_dir(cwd) / "active_conversation.json"
    if not f.exists():
        return None
    try:
        return json.loads(f.read_text()).get("conversation_id")
    except (json.JSONDecodeError, OSError):
        return None


def set_current_session(cwd: str | None, session_id: str, project_cwd: str | None) -> None:
    """A-1(#2567) idle-wake: 리스너가 「깨울 대상」을 알아야 하는데, 리스너 자체는
    한 번 뜨면 오래 살아서 spawn 시점의 session_id를 그대로 쓰면 안 됨(그 세션은 이미
    끝났을 수 있음) — SessionStart가 매번(재사용 spawn 포함) 이 파일을 갱신해, 리스너는
    "가장 최근 세션"을 항상 fresh하게 읽는다."""
    (_state_dir(cwd) / "current_session.json").write_text(
        json.dumps({"session_id": session_id, "cwd": project_cwd, "updated_at": time.time()})
    )


def get_current_session(cwd: str | None) -> dict | None:
    f = _state_dir(cwd) / "current_session.json"
    if not f.exists():
        return None
    try:
        return json.loads(f.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def reply_health_summary(cwd: str | None, window_seconds: float = 86400) -> dict:
    """최근 window_seconds 내 replied/reply_failed 집계 — A-3(#2567): 회신 실패가
    조용히 묻히지 않고 configure 상태 확인 시 보이게. 실패 예외를 events.jsonl에 남기는
    것과 별개로, 이 함수가 그 로그를 사람이 바로 읽을 요약으로 뒤집는다."""
    events_file = _state_dir(cwd) / "events.jsonl"
    summary = {"window_seconds": window_seconds, "replied": 0, "failed": 0, "last_failure": None}
    if not events_file.exists():
        return summary
    cutoff = time.time() - window_seconds
    try:
        for line in events_file.read_text().splitlines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("ts", 0) < cutoff:
                continue
            if rec.get("kind") == "replied":
                summary["replied"] += 1
            elif rec.get("kind") == "reply_failed":
                summary["failed"] += 1
                summary["last_failure"] = {
                    "ts": rec.get("ts"), "conversation_id": rec.get("conversation_id"),
                    "error": rec.get("error"),
                }
    except OSError:
        pass
    return summary


def post_reply(cwd: str | None, conversation_id: str, text: str) -> bool:
    """실패해도 예외를 던지지 않는다 — AC2(세션 안 깨뜨림). 성공 여부만 반환."""
    creds = load_credentials(cwd)
    api_key = creds.get("SPRINTABLE_API_KEY")
    if not api_key:
        return False
    api_url = creds.get("SPRINTABLE_API_URL", "https://app.sprintable.ai")
    url = f"{api_url.rstrip('/')}/api/v2/conversations/{conversation_id}/messages"
    req = urllib.request.Request(
        url, data=json.dumps({"content": text}).encode(), method="POST",
        headers={"Authorization": f"Bearer {api_key}", "x-agent-api-key": api_key,
                 "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
        log_event(cwd, "replied", conversation_id=conversation_id, text=text[:200])
        return True
    except Exception as exc:
        log_event(cwd, "reply_failed", conversation_id=conversation_id, error=str(exc))
        return False
