#!/usr/bin/env python3
"""HITL①(#2570) Path B — 인터랙티브 세션의 PreToolUse에서 Sprintable 챗으로 승인을
묻고 기다린다. Path A(server.ts의 approval_prompt MCP tool)와 별개 프로세스라
in-memory 상태 공유 불가 — server.ts가 남기는 current_conversation.json(같은
STATE_DIR)을 읽어 대상 conv를 얻고, 자체 폴링으로 챗 답을 기다린다.

AC4 기본 OFF: SPRINTABLE_HITL_APPROVAL=1이 아니면 즉시 {} 반환(세션 절대 안 깨뜨림·
기존 사용자 무회귀) — hooks.json은 매 세션 자동 로드되므로 이 게이트가 유일한 opt-in
지점이다(Path A는 --permission-prompt-tool을 사용자가 명시해야만 불려서 게이트 불요).
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path


def _state_dir() -> Path:
    override = os.environ.get("SPRINTABLE_STATE_DIR")
    if override:
        return Path(override)
    cwd = os.environ.get("CLAUDE_PROJECT_DIR")
    if cwd:
        candidate = Path(cwd) / ".sprintable"
        if (candidate / ".env").exists():
            return candidate
    return Path.home() / ".claude" / "channels" / "sprintable"


def _load_credentials() -> dict[str, str]:
    env_file = _state_dir() / ".env"
    creds: dict[str, str] = {}
    if not env_file.exists():
        return creds
    for line in env_file.read_text().splitlines():
        if "=" not in line or line.strip().startswith("#"):
            continue
        key, _, value = line.partition("=")
        creds[key.strip()] = value.strip()
    return creds


def _log_event(kind: str, **fields) -> None:
    events_file = _state_dir() / "events.jsonl"
    try:
        events_file.parent.mkdir(parents=True, exist_ok=True)
        with open(events_file, "a") as f:
            f.write(json.dumps({"ts": time.time(), "kind": kind, **fields}, ensure_ascii=False) + "\n")
    except OSError:
        pass


def _target_conversation() -> str:
    # server.ts가 매 인바운드마다 갱신하는 파일 — Path A와 같은 "active_conversation" 개념 공유.
    f = _state_dir() / "current_conversation.json"
    if f.exists():
        try:
            cid = json.loads(f.read_text()).get("conversation_id")
            if cid:
                return str(cid)
        except (json.JSONDecodeError, OSError):
            pass
    return os.environ.get("SPRINTABLE_HITL_HOME_CHANNEL", "")


def _post_message(api_url: str, api_key: str, conversation_id: str, text: str) -> bool:
    url = f"{api_url.rstrip('/')}/api/v2/conversations/{conversation_id}/messages"
    req = urllib.request.Request(
        url, data=json.dumps({"content": text}).encode(), method="POST",
        headers={"Authorization": f"Bearer {api_key}", "x-agent-api-key": api_key,
                 "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15):
            return True
    except Exception:
        return False


_DECISION_RE = re.compile(r"^\s*(allow|deny)\b\s*(.*)$", re.IGNORECASE)


def _poll_for_decision(
    api_url: str, api_key: str, conversation_id: str, since_ts: float,
    approvers: list[str], timeout_sec: float, poll_interval_sec: float = 2.0,
) -> tuple[str, str | None]:
    """반환: (behavior, message). 타임아웃 시 ("deny", 타임아웃 메시지)."""
    url = f"{api_url.rstrip('/')}/api/v2/conversations/{conversation_id}/messages?limit=10"
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        try:
            req = urllib.request.Request(
                url, headers={"Authorization": f"Bearer {api_key}", "x-agent-api-key": api_key},
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read())
            # 실측 확認: 응답 shape은 {"data": [...], "meta": {...}} (backend/app/routers/
            # conversations.py list_messages) — {"messages": [...]}가 아님.
            messages = data.get("data", []) if isinstance(data, dict) else []
            for msg in messages if isinstance(messages, list) else []:
                created_at = msg.get("created_at", "")
                try:
                    # ISO8601 -> epoch(간이 비교면 충분 — 문자열 비교로도 같은 순서지만 명시적으로).
                    import datetime
                    msg_ts = datetime.datetime.fromisoformat(created_at.replace("Z", "+00:00")).timestamp()
                except (ValueError, AttributeError):
                    continue
                if msg_ts <= since_ts:
                    continue
                sender = msg.get("sender") or {}
                content = (msg.get("content") or "").strip()
                m = _DECISION_RE.match(content)
                if not m:
                    continue
                is_human = sender.get("type") == "human"
                is_approver = not approvers or sender.get("id") in approvers
                if not (is_human and is_approver):
                    _log_event("hitl_reply_rejected", conversation_id=conversation_id,
                               sender_type=sender.get("type", ""), sender_id=sender.get("id", ""),
                               reason="not_human" if not is_human else "not_in_approver_whitelist")
                    continue
                behavior = "allow" if m.group(1).lower() == "allow" else "deny"
                return behavior, (m.group(2).strip() or None)
        except Exception as exc:
            _log_event("hitl_poll_error", conversation_id=conversation_id, error=str(exc))
        time.sleep(poll_interval_sec)
    return "deny", "챗 승인 타임아웃(무응답) — 사람이 정해진 시간 내 응답하지 않았습니다."


def main() -> None:
    if os.environ.get("SPRINTABLE_HITL_APPROVAL") != "1":
        print(json.dumps({}))
        return

    payload = json.loads(sys.stdin.read() or "{}")
    tool_name = payload.get("tool_name", "")
    tool_input = payload.get("tool_input", {})

    creds = _load_credentials()
    api_key = creds.get("SPRINTABLE_API_KEY", "")
    api_url = creds.get("SPRINTABLE_API_URL", "https://app.sprintable.ai")
    if not api_key:
        print(json.dumps({}))  # AC2 동형 — 크리덴셜 없으면 조용히 비활성, 세션 안 깨뜨림
        return

    conversation_id = _target_conversation()
    if not conversation_id:
        _log_event("hitl_no_target", tool_name=tool_name)
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": "deny",
            "permissionDecisionReason": "승인 요청 게시 대상 대화를 찾을 수 없음(안전 거부)",
        }}))
        return

    timeout_sec = (float(os.environ.get("SPRINTABLE_HITL_TIMEOUT_MS", "600000"))) / 1000
    approvers = [s.strip() for s in os.environ.get("SPRINTABLE_HITL_APPROVERS", "").split(",") if s.strip()]

    input_summary = json.dumps(tool_input, ensure_ascii=False)[:500]
    prompt_text = (
        f"🔒 승인 요청: `{tool_name}`\n입력: {input_summary}\n\n"
        f"「allow」 또는 「deny <사유>」로 답해주세요 ({int(timeout_sec)}초 내 무응답 시 자동 거부)."
    )
    request_ts = time.time()
    if not _post_message(api_url, api_key, conversation_id, prompt_text):
        _log_event("hitl_post_failed", tool_name=tool_name, conversation_id=conversation_id)
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": "deny",
            "permissionDecisionReason": "승인 요청 게시 실패(안전 거부)",
        }}))
        return
    _log_event("hitl_requested", tool_name=tool_name, conversation_id=conversation_id, input=input_summary)

    behavior, message = _poll_for_decision(api_url, api_key, conversation_id, request_ts, approvers, timeout_sec)
    _log_event("hitl_timeout" if message and "타임아웃" in message else
               ("hitl_approved" if behavior == "allow" else "hitl_denied"),
               tool_name=tool_name, conversation_id=conversation_id, message=message)

    output = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": behavior}}
    if message:
        output["hookSpecificOutput"]["permissionDecisionReason"] = message
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
