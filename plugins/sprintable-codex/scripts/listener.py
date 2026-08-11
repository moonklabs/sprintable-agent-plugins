#!/usr/bin/env python3
"""SessionStart hook가 detach로 부트하는 백그라운드 SSE 리스너.
Sprintable SSE 소비 → 큐 적재 + active_conversation 갱신 + idle-wake 시도(A-1, #2567).

A-1 idle wake: Stop hook은 turn boundary에서만 큐를 비워, 완전 idle 세션(락-프리
헤드리스가 자연종료 후 대기 중인 경우)은 메시지가 «수신은 되나 처리 안 됨»(오스카
피드백). S1(#2556)이 실증한 `codex exec resume <id> "<msg>"`(락-프리 세션 전용,
라이브 TUI는 writer-lock으로 항상 실패)를 리스너가 능동으로 걸어 깨운다:
  1. 큐에서 항목 하나 pop(원자적).
  2. `current_session.json`(SessionStart가 매번 갱신)에서 최신 session_id 조회.
  3. `codex exec -o <tmpfile> resume <session_id> "<content>"`를 백그라운드 태스크로
     시도(SSE 소비를 안 막게 asyncio.create_task — inline await 안 함).
  4. 성공(exit 0) = `<tmpfile>`을 읽어 `post_reply()`를 직접 호출 — **`resume` 호출은
     Stop hook을 재발화하지 않음을 실측 확인**(최초 turn엔 stop_fired가 찍히지만
     `resume` 뒤엔 exit 0에도 stop_fired가 전혀 없음, A1TEST 2026-08-11 실측). Stop
     훅 배치드레인에 기대면 리스너가 회신을 스스로 게시해야 pop한 항목이 실제로
     전달됨 — `wake_succeeded` 로그만으론 게시 여부를 증명 못 함(subprocess exit 0 ≠
     reply posted, 과거 오판 지점).
  5. 실패(writer-lock·세션종료·타임아웃·post_reply 실패 등) = pop한 항목을 다시
     enqueue — 기존 Stop-hook 배치드레인 폴백으로 안전하게 떨어짐(유실 없음, 그냥
     다음 자연 turn까지 대기하는 기존 동작으로 복귀).
라이브 TUI 세션에도 항상 시도한다 — 실패해도 무해(락 체크에서 즉시 실패, 모델 호출
전이라 토큰 소모 없음, S1 실측) — 세션 종류를 미리 판별할 필요가 없어 로직이 단순해짐.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _credentials import load_credentials  # noqa: E402
from _common import (  # noqa: E402
    enqueue, pop_oldest, set_active_conversation, log_event, get_seq_cursor,
    advance_seq_cursor, get_current_session, post_reply,
)

try:
    from sprintable_sse import SprintableSSEClient, MessageContext  # noqa: E402
    HTTPX_OK = True
except ImportError:
    HTTPX_OK = False

WAKE_TIMEOUT_SEC = 120


async def _attempt_wake(cwd: str | None) -> None:
    session = get_current_session(cwd)
    if not session or not session.get("session_id"):
        return
    item = pop_oldest(cwd)
    if item is None:
        return  # 이미 다른 wake 시도나 자연 Stop이 비웠음 — 할 일 없음

    codex_bin = shutil.which("codex")
    if not codex_bin:
        enqueue(cwd, item["content"], item["conversation_id"])  # 되돌려놓기
        log_event(cwd, "wake_skipped", reason="codex_binary_not_found")
        return

    session_id = session["session_id"]
    project_cwd = session.get("cwd") or cwd
    last_msg_fd, last_msg_path = tempfile.mkstemp(prefix="codex-wake-", suffix=".txt")
    os.close(last_msg_fd)
    cmd = [codex_bin, "exec", "--cd", project_cwd or ".", "--skip-git-repo-check",
           "-o", last_msg_path, "resume", session_id, item["content"]]
    log_event(cwd, "wake_attempt", session_id=session_id, row_id=item["id"])
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=os.environ.copy(),
        )
        try:
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=WAKE_TIMEOUT_SEC)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            enqueue(cwd, item["content"], item["conversation_id"])
            log_event(cwd, "wake_failed", session_id=session_id, reason="timeout")
            return
        if proc.returncode == 0:
            # resume은 Stop hook을 재발화하지 않는다(실측, 상단 docstring) — 리스너가
            # 직접 회신을 게시해야 한다. exit 0은 "턴이 돌았다"일 뿐 "회신을 올렸다"가
            # 아니다 — 과거 여기서 wake_succeeded만 찍고 post_reply를 안 불러 무음
            # 유실이 났었다.
            try:
                reply_text = Path(last_msg_path).read_text().strip()
            except OSError:
                reply_text = ""
            if not reply_text:
                enqueue(cwd, item["content"], item["conversation_id"])
                log_event(cwd, "wake_failed", session_id=session_id, row_id=item["id"],
                           reason="empty_last_message")
            else:
                result = post_reply(cwd, item["conversation_id"], reply_text, session_id=session_id)
                if result == "sent":
                    log_event(cwd, "wake_succeeded", session_id=session_id, row_id=item["id"])
                elif result == "duplicate":
                    # 이미 다른 경로(예: 거의 동시의 Stop 배치드레인)가 같은 텍스트를
                    # 게시했음 — 재큐잉하면 똑같은 내용을 무한 재시도하게 됨, 카디르
                    # QA 지적 반영.
                    log_event(cwd, "wake_deduped", session_id=session_id, row_id=item["id"])
                else:
                    enqueue(cwd, item["content"], item["conversation_id"])
                    log_event(cwd, "wake_failed", session_id=session_id, row_id=item["id"],
                               reason="post_reply_failed")
        else:
            enqueue(cwd, item["content"], item["conversation_id"])
            log_event(cwd, "wake_failed", session_id=session_id,
                       exit_code=proc.returncode, stderr=(stderr or b"").decode(errors="replace")[:500])
    except Exception as exc:
        enqueue(cwd, item["content"], item["conversation_id"])
        log_event(cwd, "wake_failed", session_id=session_id, reason=str(exc))
    finally:
        try:
            os.unlink(last_msg_path)
        except OSError:
            pass


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
    asyncio.create_task(_attempt_wake(cwd))


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
