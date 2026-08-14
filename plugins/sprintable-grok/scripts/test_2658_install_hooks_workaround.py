"""story #2658 — grok 1.0.0 never merges a plugin's own hooks/hooks.json into
the active hook set (verified, see plugin README). The existing workaround
(copy to $GROK_HOME/hooks/) only ran inside the LLM-driven configure skill —
headless/CI automation that installs the plugin without ever invoking
`/sprintable-grok:configure` never got it applied, so hooks stayed
unregistered forever (the exact class that tripped up the clone-zero
verification rig). `install_hooks_workaround.py` is the script-only,
skill-free version of that same logic; these tests pin it directly, without
needing a live grok session."""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from install_hooks_workaround import WorkaroundError, install_hooks_workaround  # noqa: E402


def _tmp_dir(prefix: str) -> Path:
    return Path(tempfile.mkdtemp(prefix=prefix))


def _fake_plugin_root(tmp: Path) -> Path:
    plugin_root = tmp / "plugin"
    hooks_dir = plugin_root / "hooks"
    hooks_dir.mkdir(parents=True)
    (hooks_dir / "hooks.json").write_text(json.dumps({
        "hooks": {
            "SessionStart": [{"hooks": [
                {"type": "command", "command": "python3 ${GROK_PLUGIN_ROOT}/scripts/session_start.py"},
            ]}],
            "Stop": [{"hooks": [
                {"type": "command", "command": "python3 ${GROK_PLUGIN_ROOT}/scripts/stop.py", "timeout": 60},
            ]}],
        },
    }))
    return plugin_root


def test_writes_hooks_json_with_literal_plugin_root_substituted():
    tmp = _tmp_dir("s2658-")
    plugin_root = _fake_plugin_root(tmp)
    grok_home = tmp / "grok_home"

    target = install_hooks_workaround(plugin_root=plugin_root, grok_home=grok_home)

    assert target == grok_home / "hooks" / "sprintable-grok.json"
    written = json.loads(target.read_text())
    session_start_cmd = written["hooks"]["SessionStart"][0]["hooks"][0]["command"]
    assert "${GROK_PLUGIN_ROOT}" not in session_start_cmd
    assert str(plugin_root) in session_start_cmd
    assert session_start_cmd == f"python3 {plugin_root}/scripts/session_start.py"


def test_writes_meta_json_with_workaround_fields():
    tmp = _tmp_dir("s2658-")
    plugin_root = _fake_plugin_root(tmp)
    grok_home = tmp / "grok_home"

    install_hooks_workaround(plugin_root=plugin_root, grok_home=grok_home)

    meta = json.loads((grok_home / "hooks" / "sprintable-grok.meta.json").read_text())
    assert meta["workaround_version"] == 1
    assert meta["plugin_root"] == str(plugin_root)
    assert "updated_at" in meta and meta["updated_at"]


def test_idempotent_rerun_refreshes_both_files():
    tmp = _tmp_dir("s2658-")
    plugin_root = _fake_plugin_root(tmp)
    grok_home = tmp / "grok_home"

    first = install_hooks_workaround(plugin_root=plugin_root, grok_home=grok_home)
    first_meta = json.loads((grok_home / "hooks" / "sprintable-grok.meta.json").read_text())
    second = install_hooks_workaround(plugin_root=plugin_root, grok_home=grok_home)
    second_meta = json.loads((grok_home / "hooks" / "sprintable-grok.meta.json").read_text())

    assert first == second
    # 재실행마다 갱신(플러그인 업그레이드 후 재적용 포함) — updated_at이 실제로 새로 쓰였는지.
    assert second_meta["updated_at"] >= first_meta["updated_at"]


def test_missing_source_hooks_json_raises_and_writes_nothing():
    tmp = _tmp_dir("s2658-")
    plugin_root = tmp / "empty_plugin"
    plugin_root.mkdir()  # hooks/hooks.json 자체가 없음
    grok_home = tmp / "grok_home"

    try:
        install_hooks_workaround(plugin_root=plugin_root, grok_home=grok_home)
        assert False, "WorkaroundError를 던졌어야 한다"
    except WorkaroundError:
        pass
    assert not (grok_home / "hooks" / "sprintable-grok.json").exists()


def test_cli_entrypoint_exit_codes(tmp_path):
    import subprocess

    plugin_root = _fake_plugin_root(tmp_path)
    grok_home = tmp_path / "grok_home"
    script = Path(__file__).resolve().parent / "install_hooks_workaround.py"

    env = {**os.environ, "GROK_HOME": str(grok_home)}
    # 스크립트 자체의 _plugin_root()는 __file__ 기준 실 플러그인 루트를 가리키므로,
    # CLI 경로 검증은 실 플러그인 트리(이 리포)를 그대로 쓴다 — 별도 fake 불필요.
    result = subprocess.run(
        [sys.executable, str(script)], env=env, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "wrote" in result.stdout
    assert (grok_home / "hooks" / "sprintable-grok.json").exists()
