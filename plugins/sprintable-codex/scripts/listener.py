#!/usr/bin/env python3
"""SessionStart hook가 detach로 부트하는 백그라운드 SSE 리스너.
Sprintable SSE 소비 → 큐 적재 + active_conversation 갱신만. 주입 자체는 Stop hook 몫
(S1 판정: 락-프리 세션엔 exec resume도 대안이나, 이 리스너 프로세스에서 직접 걸면 이
listener 자체가 살아있는 codex 세션과 경합할 필요가 없어 Stop 경로로 통일한다 —
exec resume 능동 주입은 "이 codex 프로세스가 아예 안 떠 있을 때 깨우는" 별도 시나리오로
남겨둔다, 이번 S2 스코프는 항상-떠있는 세션 채널화).
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

    # seq-커서 dedup(PR#2 리뷰 반영, S1 부가관측 #2556): backfill을 통째로 drop하면 재연결
    # 타이밍에 걸린 «진짜 새 메시지»가 조용히 유실된다(유실은 중복보다 나쁨 — 안 보임). 커서
    # 이하(이미 처리한 seq)만 진짜 재전송으로 보고 drop, 커서 초과면 backfill 플래그가 붙어
    # 있어도 "재연결 전에 놓친 새 이벤트"로 취급해 enqueue한다.
    cursor = get_seq_cursor(cwd)
    if ctx.is_backfill and (not ctx.seq or ctx.seq <= cursor):
        return
    enqueue(cwd, ctx.content, ctx.conversation_id)
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
