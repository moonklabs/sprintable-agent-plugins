"""Sprintable Gateway SSE Reference SDK — Python.

⛔story #2653(2026-08-14, 사본표류 그라운딩) — 이 파일은 정본
moonklabs/sprintable `connectors/sdk/sprintable_sse.py`의 **vendored 사본**이다
(발행 패키지가 monorepo 상대경로를 못 살려 복사가 불가피 — [[project_vendored_sdk_sync_debt]]와
동형, 근본해=SDK 패키지 추출은 S9 backlog). 마지막 동기화 기준 정본 커밋:
`ab73801b26ba6c452c8f46856558cf6b4f037092`.

⛔갈리면 안 되는 계약면(#2653 그라운딩 doc `2653-triple-vendor-drift-grounding` 표 참조,
자동가드 없음 — «정본 신필드 vs 이 사본의 의도적 축소»는 사람 리뷰 몫으로 명시 선언):
`MessageContext.sender_type`(=`sender.get("type")`) · `.event_kind`(=`event_type`,
data/payload) · `.ts`(=`data.get("created_at") or payload.get("created_at")`). 정본은
`addressed`/`audience_targeted`/`message_kind`/`expects_response` 4필드도 갖지만
(E-ACTIVATION Phase 2) 이 사본은 story #2655 스코프상 의도적으로 안 가져온다 —
회귀 아님, 다만 "앞으로도 영원히 안 쓸 것"의 보장은 아니다.

이 파일을 고칠 땐 `plugins/sprintable-grok/scripts/sprintable_sse.py`도 반드시 같이
고칠 것 — CI `sse-copy-parity` job(story #2592/#2653)이 두 사본의 byte-diff를 강제한다.

공통부: SSE 소비 · 파서 · dedup · ack(contiguous, min-1 앵커링) · backoff 재연결.
어댑터는 `on_message` 콜백(주입부)만 구현하면 된다.

Usage:
    from sprintable_sse import SprintableSSEClient, MessageContext

    async def inject(ctx: MessageContext) -> None:
        # runtime-specific turn injection
        response = await my_agent.handle(ctx.content)
        await ctx.reply(response)

    client = SprintableSSEClient(
        api_url="https://app.sprintable.ai",
        api_key="sk_live_...",
    )
    await client.run(inject)   # blocks forever, auto-reconnects
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

try:
    import httpx
    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False  # type: ignore[assignment]

logger = logging.getLogger(__name__)

DEFAULT_API_URL = "https://app.sprintable.ai"
RECONNECT_BACKOFF = [2, 5, 10, 30, 60]
STREAM_READ_TIMEOUT = 90
DEDUP_MAX_SIZE = 1000
DEDUP_TTL_SECONDS = 300.0

# ── E-EVENT-INJECT S2: 주입 허용 event_type (중앙 상수, recommended ONLY) ──────────
# 이 목록 밖의 event_type은 content가 실려있어도 work-turn으로 주입하지 않고 드롭한다
# (FYI poisoning 방지: status_changed/task_completed/agent_joined/sprint_closed/file_conflict 등).
# 워크플로 트리거(kickoff/review_request/qa_request/deploy_request/handoff)는 현재 백엔드가
# dispatched 이벤트로 전달하나, 향후 직접 event_type emit 대비해 명시 포함.
# ⚠️ 단일 출처 — hermes adapter.py가 이 상수를 import해서 사용(분기 중복 금지).
INJECTABLE_EVENT_TYPES = frozenset({
    "dispatched",
    "story_assigned",
    "conversation.message_created",
    "conversation:mention",
    "kickoff",
    "review_request",
    "qa_request",
    "deploy_request",
    "handoff",
})


# ── Public types ─────────────────────────────────────────────────────────────

@dataclass
class MessageImage:
    url: str
    name: str = ""
    mime: str = ""


@dataclass
class MessageAttachment:
    """일반 첨부(이미지 포함 전체) — #2568: 서버는 payload.attachments에 이걸 정상
    포함하지만 이 SDK가 `images`(mime.startswith("image/") 필터)만 읽고 있어 .md 등
    비-이미지 첨부가 조용히 사라졌다(백엔드는 드롭 지점 아님 — 실측 확認)."""
    url: str
    name: str = ""
    content_type: str = ""
    size: int | None = None
    asset_id: str = ""


@dataclass
class MessageContext:
    """어댑터 `on_message` 콜백에 전달되는 메시지 컨텍스트."""
    content: str
    conversation_id: str
    sender_id: str
    sender_name: str
    event_id: str
    seq: int
    is_backfill: bool
    images: list[MessageImage]
    attachments: list[MessageAttachment]
    raw: dict[str, Any]

    # story #2655 — listener.py의 on_message()가 읽는 필드. 원 이벤트에 값이 없으면
    # 빈 문자열로 둔다(지어내지 않는다). 정본(moonklabs/sprintable
    # connectors/sdk/sprintable_sse.py MessageContext)과 동형 계약 — 실측 근거는
    # 아래 _parse_event의 sender.get("type")/event_type/created_at 채움부 참조.
    sender_type: str = ""
    event_kind: str = ""
    ts: str = ""

    # reply() 지원을 위해 내부 주입
    _reply_url: str = field(default="", repr=False)
    _api_key: str = field(default="", repr=False)
    _http: Any = field(default=None, repr=False)

    async def reply(self, text: str) -> None:
        """POST /api/v2/conversations/{id}/messages."""
        if not self._reply_url or not self._http:
            raise RuntimeError("reply_url not available")
        resp = await self._http.post(
            self._reply_url,
            headers={"Authorization": f"Bearer {self._api_key}", "x-agent-api-key": self._api_key},
            json={"content": text},
            timeout=15.0,
        )
        resp.raise_for_status()


MessageHandler = Callable[[MessageContext], Awaitable[None]]


def _normalize_images(value: Any) -> list[MessageImage]:
    if not isinstance(value, list):
        return []
    images: list[MessageImage] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").strip()
        if not url:
            continue
        mime = str(item.get("mime") or item.get("mime_type") or "").strip()
        if mime and not mime.startswith("image/"):
            continue
        images.append(MessageImage(
            url=url,
            name=str(item.get("name") or ""),
            mime=mime,
        ))
    return images


def _normalize_attachments(value: Any) -> list[MessageAttachment]:
    """`images`와 달리 mime 필터 없음 — 첨부는 전 타입(.md 등)이 대상(#2568)."""
    if not isinstance(value, list):
        return []
    out: list[MessageAttachment] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").strip()
        if not url:
            continue
        size = item.get("size")
        try:
            size = int(size) if size is not None else None
        except (TypeError, ValueError):
            size = None
        out.append(MessageAttachment(
            url=url,
            name=str(item.get("name") or ""),
            content_type=str(item.get("content_type") or ""),
            size=size,
            asset_id=str(item.get("asset_id") or ""),
        ))
    return out


def render_attachment_notice(attachments: list[MessageAttachment]) -> str:
    """#2568 AC3: 첨부 존재+회수 경로(asset text API)를 에이전트가 알 수 있게 텍스트로
    안내. asset_id가 있으면(정상 케이스) 그 경로를, 없으면(레거시/미등록) url을 안내."""
    lines = []
    for a in attachments:
        label = a.name or a.url
        if a.asset_id:
            lines.append(
                f"- {label} ({a.content_type or 'unknown type'}) — "
                f"본문 회수: GET /api/v2/assets/{a.asset_id}/text"
            )
        else:
            lines.append(f"- {label} ({a.content_type or 'unknown type'}) — url: {a.url}")
    return f"[첨부 {len(attachments)}건]\n" + "\n".join(lines) + "\n[/첨부]"


# ── SDK client ────────────────────────────────────────────────────────────────

class SprintableSSEClient:
    """Sprintable Gateway SSE dial-out 클라이언트.

    `run(on_message)` 한 번 호출로 SSE 스트림 소비 + ack 처리 + 재연결을 담당.
    어댑터는 `on_message(MessageContext)` 콜백만 구현.
    """

    def __init__(self, api_url: str = DEFAULT_API_URL, api_key: str = "") -> None:
        if not HTTPX_AVAILABLE:
            raise ImportError("httpx is required: pip install httpx")
        self._api_url = api_url.rstrip("/")
        self._api_key = api_key
        self._http: httpx.AsyncClient | None = None
        self._last_event_id = ""
        self._last_acked = 0
        self._seen: dict[str, float] = {}

    def _auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._api_key}", "x-agent-api-key": self._api_key}

    def _is_dup(self, event_id: str) -> bool:
        now = time.time()
        if len(self._seen) > DEDUP_MAX_SIZE:
            self._seen = {k: v for k, v in self._seen.items() if v > now - DEDUP_TTL_SECONDS}
        if event_id in self._seen:
            return True
        self._seen[event_id] = now
        return False

    async def _ack(self, seq: int) -> None:
        """contiguous-ack: seq <= _last_acked 이면 skip."""
        if seq <= self._last_acked or not self._http:
            return
        try:
            await self._http.post(
                f"{self._api_url}/api/v2/agent/events/ack",
                headers=self._auth(), json={"seq": seq}, timeout=10.0,
            )
            self._last_acked = seq
            logger.debug("ack seq=%d", seq)
        except Exception as exc:
            logger.warning("ack error seq=%d: %s", seq, exc)

    async def _parse_event(self, ev_type: str, ev_id: str, data_str: str) -> MessageContext | None:
        """SSE 이벤트 → MessageContext. heartbeat / no-content 는 None."""
        if ev_type == "heartbeat":
            return None
        try:
            data: dict[str, Any] = json.loads(data_str)
        except json.JSONDecodeError:
            return None

        payload = data.get("payload") or {}
        if isinstance(payload, str):
            payload = {}
        # E-EVENT-INJECT S2: recommended ONLY allow-list (content 체크 전). FYI 등은 드롭.
        event_type = data.get("event_type") or payload.get("event_type")
        if event_type not in INJECTABLE_EVENT_TYPES:
            return None
        content = (data.get("content") or payload.get("content") or "").strip()
        images = _normalize_images(data.get("images") or payload.get("images"))
        attachments = _normalize_attachments(data.get("attachments") or payload.get("attachments"))
        if not content and not images and not attachments:
            return None
        # #2568 AC2/AC3: 첨부가 있으면 안내 블록을 content에 병합 — 어댑터마다 따로
        # 렌더하게 하지 않고 SDK 단일 지점에서 처리(어댑터 코드 수정 0으로 전파).
        if attachments:
            notice = render_attachment_notice(attachments)
            content = f"{content}\n\n{notice}" if content else notice

        event_id = str(data.get("event_id") or payload.get("id") or ev_id or uuid.uuid4())
        if self._is_dup(event_id):
            return None
        if ev_id:
            self._last_event_id = ev_id

        # seq: data 최상위 → payload fallback
        seq = 0
        for cand in (data.get("recipient_seq"), payload.get("recipient_seq")):
            try:
                n = int(cand)  # type: ignore[arg-type]
                if n > 0:
                    seq = n
                    break
            except (TypeError, ValueError):
                pass

        conversation_id = str(
            payload.get("conversation_id") or payload.get("thread_id")
            or data.get("conversation_id") or ""
        )
        sender = payload.get("sender") or {}
        if isinstance(sender, str):
            sender = {}
        sender_id = str(sender.get("id") or data.get("sender_id") or "sprintable")
        sender_name = str(sender.get("name") or sender_id)
        sender_type = str(sender.get("type") or "")
        is_backfill = bool(data.get("is_backfill"))
        ts = str(data.get("created_at") or payload.get("created_at") or "")

        reply_url = (
            f"{self._api_url}/api/v2/conversations/{conversation_id}/messages"
            if conversation_id else ""
        )

        return MessageContext(
            content=content,
            conversation_id=conversation_id,
            sender_id=sender_id,
            sender_name=sender_name,
            event_id=event_id,
            seq=seq,
            is_backfill=is_backfill,
            images=images,
            attachments=attachments,
            raw=data,
            sender_type=sender_type,
            event_kind=str(event_type or ""),
            ts=ts,
            _reply_url=reply_url,
            _api_key=self._api_key,
            _http=self._http,
        )

    async def _consume(self, on_message: MessageHandler) -> None:
        assert self._http is not None
        headers = {**self._auth(), "Accept": "text/event-stream", "Cache-Control": "no-cache"}
        if self._last_event_id:
            headers["Last-Event-ID"] = self._last_event_id

        ev_type, ev_id, data_lines = "message", "", []
        async with self._http.stream(
            "GET", f"{self._api_url}/api/v2/agent/stream", headers=headers,
            timeout=httpx.Timeout(connect=15.0, read=STREAM_READ_TIMEOUT, write=15.0, pool=15.0),
        ) as resp:
            resp.raise_for_status()
            logger.info("stream open")
            async for raw in resp.aiter_lines():
                line = raw.rstrip("\n")
                if line == "":
                    if data_lines:
                        ctx = await self._parse_event(ev_type, ev_id, "\n".join(data_lines))
                        if ctx is not None:
                            logger.info("inbound seq=%d conv=%s: %s",
                                        ctx.seq, ctx.conversation_id, ctx.content[:80])
                            await on_message(ctx)
                            if ctx.seq:
                                await self._ack(ctx.seq)
                    ev_type, ev_id, data_lines = "message", "", []
                elif line.startswith(":"):
                    pass
                elif line.startswith("event:"):
                    ev_type = line[6:].strip()
                elif line.startswith("id:"):
                    ev_id = line[3:].strip()
                elif line.startswith("data:"):
                    v = line[5:]
                    data_lines.append(v[1:] if v.startswith(" ") else v)
        logger.info("stream closed")

    async def run(self, on_message: MessageHandler) -> None:
        """SSE 스트림 소비 + ack + backoff 재연결. 무한 루프."""
        self._http = httpx.AsyncClient(timeout=None)
        backoff_idx = 0
        try:
            while True:
                t0 = time.monotonic()
                try:
                    await self._consume(on_message)
                except asyncio.CancelledError:
                    return
                except Exception:
                    # story #2655 — 이전엔 logger.warning(one-liner, no traceback)이라
                    # on_message 콜백 크래시(예: AttributeError)가 평범한 네트워크 재연결
                    # 블립과 구분 안 됐다(「조용히 no-op」 철학이 콜백 버그까지 삼킨 사고
                    # 케이스). exception()으로 풀 traceback을 남겨 재연결 루프는 그대로
                    # 유지하되(가용성 우선) 원인은 로그에서 즉시 식별 가능하게 한다.
                    logger.exception("stream error")
                if time.monotonic() - t0 >= 60.0:
                    backoff_idx = 0
                delay = RECONNECT_BACKOFF[min(backoff_idx, len(RECONNECT_BACKOFF) - 1)]
                logger.info("reconnecting in %ds", delay)
                await asyncio.sleep(delay)
                backoff_idx += 1
        finally:
            await self._http.aclose()
            self._http = None
