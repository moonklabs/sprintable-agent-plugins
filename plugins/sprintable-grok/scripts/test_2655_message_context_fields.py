"""story #2655 — codex plugin: MessageContext에 sender_type/event_kind/ts 3필드
부재로 on_message()가 매번 AttributeError를 던지고(listener.py:148-149) 조용한
재연결 루프(run()의 generic `except Exception`)에 삼켜져 codex/grok 인바운드가
100% 크래시하던 사고의 회귀 pin.

값 출처는 추측이 아니라 정본(moonklabs/sprintable connectors/sdk/sprintable_sse.py
MessageContext._parse_event 실측): sender_type=sender.get("type"),
event_kind=event_type(data/payload의 event_type), ts=data/payload의 created_at.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sprintable_sse import MessageContext, SprintableSSEClient  # noqa: E402
import _common  # noqa: E402
from listener import on_message  # noqa: E402


def _client() -> SprintableSSEClient:
    return SprintableSSEClient(api_url="https://example.test", api_key="k")


def test_message_context_has_default_empty_string_fields():
    """AC1 — 필드가 dataclass에 실재하고(속성 접근이 AttributeError를 안 던짐),
    값 없을 때 빈 문자열(지어내지 않음)."""
    ctx = MessageContext(
        content="x", conversation_id="c", sender_id="s", sender_name="s",
        event_id="e", seq=1, is_backfill=False, images=[], attachments=[], raw={},
    )
    assert ctx.sender_type == ""
    assert ctx.event_kind == ""
    assert ctx.ts == ""


def test_parse_event_fills_fields_from_real_backend_payload_shape():
    """AC1/AC2 — 실 SSE data 페이로드 모양(sender.type/event_type/created_at)에서
    채워진다. listener.py의 crash 재현 문장 그대로(ctx.sender_type 등 접근)."""
    client = _client()
    payload = {
        "event_type": "conversation.message_created",
        "content": "안녕",
        "conversation_id": "conv-1",
        "created_at": "2026-08-14T10:00:00Z",
        "sender": {"id": "u1", "name": "송윤재", "type": "human"},
        "recipient_seq": 42,
    }
    data_str = json.dumps({"payload": payload})
    ctx = asyncio.run(client._parse_event("message", "ev-1", data_str))
    assert ctx is not None
    # 이전엔 여기서 AttributeError: 'MessageContext' object has no attribute 'sender_type'
    assert ctx.sender_type == "human"
    assert ctx.event_kind == "conversation.message_created"
    assert ctx.ts == "2026-08-14T10:00:00Z"


def test_parse_event_top_level_data_shape_also_fills_fields():
    """실측 근거 확장 — payload가 아니라 data 최상위에 실리는 변형도 동형 처리
    (기존 코드가 이미 content/conversation_id에 대해 이 이중 fallback을 쓰고 있어
    sender_type/event_kind/ts도 같은 계약을 따라야 한다)."""
    client = _client()
    data_str = json.dumps({
        "event_type": "dispatched",
        "content": "배정됨",
        "conversation_id": "conv-2",
        "created_at": "2026-08-14T11:00:00Z",
        "sender_id": "agent-9",
        "recipient_seq": 7,
    })
    ctx = asyncio.run(client._parse_event("message", "ev-2", data_str))
    assert ctx is not None
    assert ctx.event_kind == "dispatched"
    assert ctx.ts == "2026-08-14T11:00:00Z"
    # sender dict가 아예 없으면 type은 정직하게 빈 문자열(지어내지 않음).
    assert ctx.sender_type == ""


def test_on_message_end_to_end_no_crash_and_enqueues():
    """AC2 — sse_received → on_message(listener.py:148-149의 실제 크래시 문장 그대로
    ctx.sender_type/event_kind/ts를 읽음) → enqueue 실도달을 crash 0으로 재현. 카디르
    clone-zero rig의 핵심 관측(sse_received 후 매번 크래시)을 로컬 unit 경계에서 pin."""
    client = _client()
    payload = {
        "event_type": "conversation.message_created",
        "content": "안녕",
        "conversation_id": "conv-e2e",
        "created_at": "2026-08-14T12:00:00Z",
        "sender": {"id": "u1", "name": "송윤재", "type": "human"},
        "recipient_seq": 1,
    }
    ctx = asyncio.run(client._parse_event("message", "ev-e2e", json.dumps({"payload": payload})))
    assert ctx is not None

    cwd = tempfile.mkdtemp(prefix="codex-2655-test-")
    os.environ["SPRINTABLE_STATE_DIR"] = cwd
    try:
        asyncio.run(on_message(cwd, ctx))  # 이전엔 여기서 AttributeError
        item = _common.pop_oldest(cwd)
        assert item is not None
        assert item["content"] == "안녕"
        assert item["sender_type"] == "human"
        assert item["event_kind"] == "conversation.message_created"
        assert item["ts"] == "2026-08-14T12:00:00Z"
    finally:
        del os.environ["SPRINTABLE_STATE_DIR"]


def test_run_logs_full_traceback_on_callback_crash_not_generic_warning(caplog):
    """AC4 — on_message 콜백 예외가 조용한 재연결 루프에 무로그로 삼켜지지 않는다.
    이전엔 logger.warning(1줄, traceback 없음)이라 평범한 네트워크 재연결과 구분이
    안 됐다 — logger.exception으로 바뀌어 풀 traceback이 남는지 pin."""
    client = _client()

    async def _boom_consume(_on_message):
        raise RuntimeError("on_message crashed: no attribute sender_type")

    client._consume = _boom_consume  # type: ignore[method-assign]

    async def _sleep_then_cancel(_delay):
        raise asyncio.CancelledError()

    async def _dummy_on_message(_ctx):
        return None

    with caplog.at_level(logging.ERROR):
        orig_sleep = asyncio.sleep
        asyncio.sleep = _sleep_then_cancel  # type: ignore[assignment]
        try:
            try:
                asyncio.run(client.run(_dummy_on_message))
            except asyncio.CancelledError:
                pass
        finally:
            asyncio.sleep = orig_sleep  # type: ignore[assignment]

    error_records = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert error_records, "on_message crash가 ERROR 레벨로 안 남았다"
    assert any(r.exc_info for r in error_records), (
        "logger.exception이 아니라 여전히 logger.warning류 — traceback 미포함"
    )
    assert "RuntimeError" in caplog.text and "on_message crashed" in caplog.text
