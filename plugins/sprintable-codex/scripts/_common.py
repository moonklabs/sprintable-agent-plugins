"""Sprintable codex plugin — shared queue/state helpers.

S1 스파이크(#2556) 실측 위에서 프로덕션화. 스파이크 대비 바뀐 점:
  - 크리덴셜/상태 경로가 고정 단일 conv이 아니라 _credentials 체인으로 해석됨.
  - 회신 대상 conversation_id를 큐 row가 아니라 "세션의 active conversation"으로 추적
    (사용자 자체 턴에 대한 응답도 회신해야 하므로 — 큐 항목에만 달려있으면 못 잡음).
  - AC2: 크리덴셜 미설정이면 모든 함수가 조용히 no-op(예외 없이) — 세션을 절대 안 깨뜨림.
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


# story #2583 — 큐 항목이 conversation_id/content만 실어 stop.py까지 넘어가면 발신자/이벤트
# 종류/ts가 조립 단계에서 버려진다(정찰 doc 2583-injection-envelope-recon-20260812가 codex를
# 정확히 이 클래스로 특定). 큐 스키마 자체를 확장해 envelope 필드를 pop 이후까지 보존한다.
_ENVELOPE_QUEUE_COLUMNS = ("sender_name", "sender_id", "sender_type", "event_kind", "ts")


def _conn(cwd: str | None) -> sqlite3.Connection:
    conn = sqlite3.connect(str(_state_dir(cwd) / "queue.sqlite"), timeout=10)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS queue ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, "
        "conversation_id TEXT, created_at REAL NOT NULL, "
        "sender_name TEXT NOT NULL DEFAULT '', sender_id TEXT NOT NULL DEFAULT '', "
        "sender_type TEXT NOT NULL DEFAULT '', event_kind TEXT NOT NULL DEFAULT '', "
        "ts TEXT NOT NULL DEFAULT '')"
    )
    # 이 변경 前에 이미 만들어진 queue.sqlite는 위 CREATE TABLE IF NOT EXISTS가 손 안 댐 —
    # 기존 파일에 새 컬럼을 직접 추가(idempotent: 이미 있으면 sqlite3.OperationalError를
    # 잡고 무시 — ALTER TABLE엔 IF NOT EXISTS가 없다).
    existing = {row[1] for row in conn.execute("PRAGMA table_info(queue)").fetchall()}
    for col in _ENVELOPE_QUEUE_COLUMNS:
        if col not in existing:
            try:
                conn.execute(f"ALTER TABLE queue ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")
            except sqlite3.OperationalError:
                pass  # 동시 프로세스가 먼저 추가했을 수 있음 — 결과는 같으니 무시.
    return conn


def enqueue(
    cwd: str | None, content: str, conversation_id: str, *,
    sender_name: str = "", sender_id: str = "", sender_type: str = "",
    event_kind: str = "", ts: str = "",
) -> int:
    conn = _conn(cwd)
    try:
        cur = conn.execute(
            "INSERT INTO queue (content, conversation_id, created_at, "
            "sender_name, sender_id, sender_type, event_kind, ts) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (content, conversation_id, time.time(), sender_name, sender_id, sender_type, event_kind, ts),
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
            "SELECT id, content, conversation_id, created_at, "
            "sender_name, sender_id, sender_type, event_kind, ts "
            "FROM queue ORDER BY id ASC LIMIT 1"
        ).fetchone()
        if row is None:
            conn.execute("COMMIT")
            return None
        conn.execute("DELETE FROM queue WHERE id = ?", (row[0],))
        conn.commit()
        item = {
            "id": row[0], "content": row[1], "conversation_id": row[2], "created_at": row[3],
            "sender_name": row[4], "sender_id": row[5], "sender_type": row[6],
            "event_kind": row[7], "ts": row[8],
        }
        log_event(cwd, "popped", row_id=row[0], enqueued_at=row[3])
        return item
    finally:
        conn.close()


def _requeue(cwd: str | None, item: dict) -> int:
    """실패/재시도 경로에서 pop한 item을 그대로 되돌려놓는다 — envelope 필드까지 보존
    (예전엔 content/conversation_id만 살아남아 재시도판이 발신자를 잃었다)."""
    return enqueue(
        cwd, item["content"], item["conversation_id"],
        sender_name=item.get("sender_name", ""), sender_id=item.get("sender_id", ""),
        sender_type=item.get("sender_type", ""), event_kind=item.get("event_kind", ""),
        ts=item.get("ts", ""),
    )


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


def _claim_reply_once(cwd: str | None, session_id: str | None, text: str) -> bool:
    """(session_id, text) 조합이 처음이면 True(회신 진행), 이미 처리됐으면 False(스킵).
    이중발화 내성 — A-1(#2567) 리뷰 지적: wake의 post_reply 직호출과 그 resume turn
    자체의 Stop hook이 (실측상 resume은 Stop을 재발화 안 하지만, 그건 관측이지 구조적
    보장이 아니다) 혹시라도 같은 last_assistant_message에 반응해도 회신은 정확히 1회만
    나가도록 UNIQUE 제약으로 원자 보장 — grok 플러그인의 동일 가드와 같은 설계."""
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
    """POST 실패가 확定되면 클레임을 즉시 해제 — 카디르 QA 지적(#2567 PR#7): 선점을
    POST 성공 전에 커밋하므로, 실패해도 해제 안 하면 «클레임 성공→POST 실패→재시도가
    영구 dedup에 막힘» 무음유실이 남는다. 선점 자체는 유지(POST 전으로 옮기면 listener와
    Stop이 동시에 같은 텍스트를 노려 이중게시 race가 다시 열림 — 그건 원래 방지 대상)."""
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
    (AC2: 세션 안 깨뜨림)."""
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
