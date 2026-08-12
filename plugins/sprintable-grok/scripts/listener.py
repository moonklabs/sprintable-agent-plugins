#!/usr/bin/env python3
"""SessionStart hook가 detach로 부트하는 백그라운드 SSE 리스너.
Sprintable SSE 소비 → 큐 적재 + active_conversation 갱신만. 주입 자체는 Stop hook 몫.
seq-커서 dedup 포함(codex S2 PR#2 리뷰 반영분 그대로 계승 — backfill을 통째로 drop하면
재연결 타이밍에 걸린 진짜 새 메시지가 유실될 수 있어, 커서 이하만 drop한다).
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _credentials import load_credentials  # noqa: E402
from _common import (  # noqa: E402
    enqueue, set_active_conversation, log_event, get_seq_cursor, advance_seq_cursor,
)

try:
    from sprintable_sse import SprintableSSEClient, MessageContext  # noqa: E402
    HTTPX_OK = True
except ImportError:
    HTTPX_OK = False


async def on_message(cwd: str | None, ctx) -> None:
    log_event(cwd, "sse_received", conversation_id=ctx.conversation_id, seq=ctx.seq,
              is_backfill=ctx.is_backfill)

    cursor = get_seq_cursor(cwd)
    if ctx.is_backfill and (not ctx.seq or ctx.seq <= cursor):
        return
    enqueue(
        cwd, ctx.content, ctx.conversation_id,
        sender_name=ctx.sender_name, sender_id=ctx.sender_id, sender_type=ctx.sender_type,
        event_kind=ctx.event_kind, ts=ctx.ts,
    )
    set_active_conversation(cwd, ctx.conversation_id)
    advance_seq_cursor(cwd, ctx.seq)


async def main(cwd: str | None) -> None:
    creds = load_credentials(cwd)
    api_key = creds.get("SPRINTABLE_API_KEY")
    if not api_key or not HTTPX_OK:
        log_event(cwd, "listener_disabled", reason="no_credentials" if not api_key else "no_httpx")
        return
    api_url = creds.get("SPRINTABLE_API_URL", "https://app.sprintable.ai")
    log_event(cwd, "listener_start", api_url=api_url)
    client = SprintableSSEClient(api_url=api_url, api_key=api_key)
    await client.run(lambda ctx: on_message(cwd, ctx))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", default=None)
    args = parser.parse_args()
    try:
        asyncio.run(main(args.cwd or None))
    except KeyboardInterrupt:
        pass
