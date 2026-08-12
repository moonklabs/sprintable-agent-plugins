"""Sprintable grok plugin — shared queue/state helpers.

Ported from sprintable-codex (#2557), same design: batched Stop-hook
injection, active-conversation tracking for reply routing, seq-cursor dedup
on backfill. AC3: every function is a safe no-op (or returns falsy) when
credentials are unset — never raises past a hook, never breaks the session.
"""
from __future__ import annotations

import hashlib
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


def _claim_reply_once(cwd: str | None, session_id: str | None, text: str) -> bool:
    """(session_id, text) 조합이 처음이면 True(회신 진행), 이미 처리됐으면 False(스킵).
    이중발화 내성(PO 가드 ③) — 워크어라운드 hook과 향후 native plugin hook이 같은
    Stop 이벤트에 둘 다 반응해도 회신은 정확히 1회만 나가도록 UNIQUE 제약으로 원자 보장."""
    conn = _conn(cwd)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS replied ("
            "session_id TEXT NOT NULL, content_hash TEXT NOT NULL, "
            "created_at REAL NOT NULL, UNIQUE(session_id, content_hash))"
        )
        content_hash = hashlib.sha256(text.encode()).hexdigest()
        try:
            conn.execute(
                "INSERT INTO replied (session_id, content_hash, created_at) VALUES (?, ?, ?)",
                (session_id or "", content_hash, time.time()),
            )
            conn.commit()
            return True
        except sqlite3.IntegrityError:
            return False
    finally:
        conn.close()


def _release_claim(cwd: str | None, session_id: str | None, text: str) -> None:
    """POST 실패가 확定되면 클레임을 즉시 해제 — codex PR#7(#2567) 카디르 QA 지적을
    그대로 이식: 선점을 POST 성공 전에 커밋하므로, 실패해도 해제 안 하면 «클레임
    성공→POST 실패→재시도가 영구 dedup에 막힘» 무음유실이 남는다. 선점 자체는 유지
    (POST 전으로 옮기면 listener와 Stop이 동시에 같은 텍스트를 노려 이중게시 race가
    다시 열림 — 그건 원래 방지 대상)."""
    conn = _conn(cwd)
    try:
        content_hash = hashlib.sha256(text.encode()).hexdigest()
        conn.execute(
            "DELETE FROM replied WHERE session_id = ? AND content_hash = ?",
            (session_id or "", content_hash),
        )
        conn.commit()
    finally:
        conn.close()


def post_reply(cwd: str | None, conversation_id: str, text: str, session_id: str | None = None) -> str:
    """반환값 3종: "sent"(게시 성공) | "duplicate"(이미 게시됨·재시도 불필요) |
    "failed"(게시 실패·재시도 필요 — 클레임도 해제해둠). 실패해도 예외는 안 던진다
    (AC3: 세션 안 깨뜨림)."""
    if session_id is not None and not _claim_reply_once(cwd, session_id, text):
        log_event(cwd, "reply_deduped", session_id=session_id)
        return "duplicate"
    creds = load_credentials(cwd)
    api_key = creds.get("SPRINTABLE_API_KEY")
    if not api_key:
        if session_id is not None:
            _release_claim(cwd, session_id, text)
        return "failed"
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
        return "sent"
    except Exception as exc:
        log_event(cwd, "reply_failed", conversation_id=conversation_id, error=str(exc))
        if session_id is not None:
            _release_claim(cwd, session_id, text)
        return "failed"
