"""story #2583 — grok plugin: envelope render pin + queue-schema migration +
roundtrip preservation. Recon (doc 2583-injection-envelope-recon-20260812)
found stop.py's batched reason built from item["content"] alone; the queue
(_common.py's SQLite table) had no columns for sender/event_kind/ts at all,
so even fixing stop.py's rendering wouldn't help without first threading
those fields through enqueue()/pop_oldest() and the on-disk schema.
"""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from envelope import format_envelope_text  # noqa: E402
from stop import _render  # noqa: E402
import _common  # noqa: E402


def test_pinned_full_envelope():
    out = format_envelope_text(
        "안녕하세요", sender_name="송윤재", sender_id="u1", sender_type="human",
        event_kind="conversation.message_created", ts="2026-08-12T10:00:00Z",
        conversation_id="conv-abc-123",
    )
    assert out == (
        "[conversation.message_created] 송윤재 (human) · conv=conv-abc-123 · "
        "ts=2026-08-12T10:00:00Z\n안녕하세요"
    )


def test_missing_fields_render_as_unknown():
    out = format_envelope_text("x", sender_name="누군가", conversation_id="conv-known")
    assert out.count("unknown") == 3  # sender_type/event_kind/ts만 unknown
    assert "conv=conv-known" in out


def test_fully_empty_sender_falls_back_through_id_to_unknown():
    out = format_envelope_text("x", conversation_id="conv-known")
    assert out.count("unknown") == 4  # sender_name도 id도 없어 이름칸까지 unknown


def test_misaddressing_scenario_blocked():
    first = format_envelope_text(
        "통신점검", sender_name="페드루 올리베이라", sender_type="agent",
        event_kind="conversation.message_created", ts="2026-08-12T09:00:00Z",
        conversation_id="conv-1",
    )
    second = format_envelope_text(
        "이거 다시 봐줘", sender_name="송윤재", sender_type="human",
        event_kind="conversation.message_created", ts="2026-08-12T09:05:00Z",
        conversation_id="conv-1",
    )
    assert "페드루 올리베이라" not in second
    header, body = second.split("\n", 1)
    assert "송윤재" in header
    assert body == "이거 다시 봐줘"


def _tmp_cwd() -> str:
    return tempfile.mkdtemp(prefix="codex-envelope-test-")


def test_enqueue_pop_roundtrip_preserves_envelope_fields():
    cwd = _tmp_cwd()
    os.environ["SPRINTABLE_STATE_DIR"] = cwd
    try:
        _common.enqueue(
            cwd, "hello", "conv-1", sender_name="tester", sender_id="s1",
            sender_type="human", event_kind="dispatched", ts="2026-08-12T00:00:00Z",
        )
        item = _common.pop_oldest(cwd)
        assert item is not None
        assert item["content"] == "hello"
        assert item["sender_name"] == "tester"
        assert item["sender_id"] == "s1"
        assert item["sender_type"] == "human"
        assert item["event_kind"] == "dispatched"
        assert item["ts"] == "2026-08-12T00:00:00Z"
    finally:
        del os.environ["SPRINTABLE_STATE_DIR"]


def test_queue_schema_migrates_existing_pre_2583_database():
    """story #2583 AC — 이 변경 前에 이미 만들어진 queue.sqlite(옛 4-컬럼 스키마)가
    있어도 크래시 없이 envelope 컬럼이 추가된다(라이브 사용자의 기존 상태 디렉터리를
    시뮬레이션 — ALTER TABLE 경로가 실제로 도는지 확인)."""
    cwd = _tmp_cwd()
    os.environ["SPRINTABLE_STATE_DIR"] = cwd
    try:
        # 옛 스키마를 손으로 만들어 "이 fix 前부터 있던 DB"를 재현.
        db_path = os.path.join(cwd, "queue.sqlite")
        conn = sqlite3.connect(db_path)
        conn.execute(
            "CREATE TABLE queue (id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "content TEXT NOT NULL, conversation_id TEXT, created_at REAL NOT NULL)"
        )
        conn.execute(
            "INSERT INTO queue (content, conversation_id, created_at) VALUES (?, ?, ?)",
            ("legacy row", "conv-legacy", 0.0),
        )
        conn.commit()
        conn.close()

        # 새 enqueue()/pop_oldest()가 이 기존 DB에 대해 크래시 없이 동작해야 한다.
        _common.enqueue(cwd, "new row", "conv-new", sender_name="A")
        first = _common.pop_oldest(cwd)  # 레거시 row(더 오래됨, id 낮음)가 먼저 나옴
        assert first["content"] == "legacy row"
        assert first["sender_name"] == ""  # 마이그레이션 기본값 — 지어내지 않음
        second = _common.pop_oldest(cwd)
        assert second["content"] == "new row"
        assert second["sender_name"] == "A"
    finally:
        del os.environ["SPRINTABLE_STATE_DIR"]


def test_stop_render_uses_envelope_not_bare_content():
    item = {
        "content": "hi", "conversation_id": "c1", "sender_name": "tester",
        "sender_id": "s1", "sender_type": "human", "event_kind": "dispatched", "ts": "",
    }
    out = _render(item)
    assert out != "hi"
    assert "tester" in out
    assert out.endswith("\nhi")
