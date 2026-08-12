"""story #2589 — pins _conversation_routing_suffix()'s output for a fixed
sample CLAUDE_PROJECT_DIR. The exact same sample + expected value is pinned
in ../conversation-routing.test.ts (TypeScript side) — if you change the
substitution regex here, that TS test will fail until you mirror the change
there too (and vice versa). This pin IS the parity guard the two processes
(server.ts and this hook) rely on to agree on a filename with zero
inter-process coordination.

Also reproduces story #2589's original defect (RED) against the pre-fix
shared filename, and confirms the fix (GREEN) — two workers with different
CLAUDE_PROJECT_DIR no longer collide on the same current_conversation.json.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hitl_approval_hook as h

SAMPLE_PROJECT_DIR = "/Users/yoonjae/.neoclaw-nwachukwu/state/actors/nwachukwu/workspace"
EXPECTED_SUFFIX = "_Users_yoonjae__neoclaw-nwachukwu_state_actors_nwachukwu_workspace"


def test_pinned_suffix_matches_ts_side(monkeypatch):
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", SAMPLE_PROJECT_DIR)
    assert h._conversation_routing_suffix() == f".{EXPECTED_SUFFIX}"
    assert h._current_conversation_filename() == f"current_conversation.{EXPECTED_SUFFIX}.json"


def test_two_actor_workspaces_never_collide_on_filename(monkeypatch):
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", "/Users/yoonjae/.neoclaw-nwachukwu/state/actors/nwachukwu/workspace")
    a = h._current_conversation_filename()
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", "/Users/yoonjae/.neoclaw-mirko/state/actors/mirko/workspace")
    b = h._current_conversation_filename()
    assert a != b


def test_unset_project_dir_falls_back_to_legacy_filename(monkeypatch):
    monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)
    assert h._current_conversation_filename() == "current_conversation.json"


def test_cross_worker_misrouting_fixed(tmp_path, monkeypatch):
    """story #2589 AC2 — 픽스 後 같은 STATE_DIR을 공유해도(예전엔 그게 원인) 워커 A의
    타깃이 워커 B 인바운드로 안 갈린다. 픽스 前엔 이 테스트가 fail했다(레거시 파일명
    'current_conversation.json' 하나로 양쪽 다 쓰던 시절 — repro.py의 RED 재현과 동형)."""
    monkeypatch.setenv("SPRINTABLE_STATE_DIR", str(tmp_path))

    conv_a, conv_b = "aaaaaaaa-0000-0000-0000-000000000001", "bbbbbbbb-0000-0000-0000-000000000002"

    # 워커 A 인바운드 — A의 CLAUDE_PROJECT_DIR로 A 전용 파일에 씀.
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", "/Users/yoonjae/.neoclaw-nwachukwu/state/actors/nwachukwu/workspace")
    a_file = tmp_path / h._current_conversation_filename()
    a_file.write_text(f'{{"conversation_id": "{conv_a}", "updated_at": 0}}')

    # 워커 B 인바운드 — B의 CLAUDE_PROJECT_DIR로 B 전용 파일에 씀(A 파일과 다른 이름).
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", "/Users/yoonjae/.neoclaw-mirko/state/actors/mirko/workspace")
    b_file = tmp_path / h._current_conversation_filename()
    assert b_file != a_file
    b_file.write_text(f'{{"conversation_id": "{conv_b}", "updated_at": 0}}')

    # 워커 A가 지금 승인 트리거 — A의 CLAUDE_PROJECT_DIR로 되돌아가 자기 파일만 읽는다.
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", "/Users/yoonjae/.neoclaw-nwachukwu/state/actors/nwachukwu/workspace")
    assert h._target_conversation() == conv_a  # B가 아니라 자기 자신
