#!/usr/bin/env python3
"""story #2658 — standalone, script-only copy of the configure skill's "Hook
activation workaround" (skills/configure/SKILL.md). That workaround exists
because grok 1.0.0's plugin-hook discovery never merges a plugin's own
`hooks/hooks.json` into the active hook set at session start (verified with
`RUST_LOG=debug`: `xai_grok_hooks::discovery` only scans 4 hardcoded global
sources, plugin-sourced hooks never among them — see plugin README) — the
workaround copies this plugin's hooks.json to `$GROK_HOME/hooks/`, a source
grok *does* scan.

Why this script exists separately from the skill: the skill only runs inside
an LLM-driven Grok session (a slash command) — headless/CI/fleet automation
that does `grok plugin install ...` without ever starting an interactive or
`-p` session that invokes `/sprintable-grok:configure` never gets the
workaround applied, so its hooks stay unregistered forever (story #2658 —
this is exactly what tripped up the clone-zero verification rig). This
script does the identical four steps without needing an LLM in the loop, so
automation can call it directly after install:

    grok plugin install moonklabs/sprintable-agent-plugins#plugins/sprintable-grok --trust
    python3 <plugin_root>/scripts/install_hooks_workaround.py

The configure skill still runs this same logic for interactive users (as a
Save side effect, per SKILL.md) — kept as the single implementation both
paths call, so the two don't drift.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

WORKAROUND_VERSION = 1


class WorkaroundError(Exception):
    pass


def _plugin_root() -> Path:
    # this file: <plugin_root>/scripts/install_hooks_workaround.py
    return Path(__file__).resolve().parent.parent


def _grok_home() -> Path:
    return Path(os.environ.get("GROK_HOME", Path.home() / ".grok"))


def install_hooks_workaround(*, plugin_root: Path | None = None, grok_home: Path | None = None) -> Path:
    """Writes `$GROK_HOME/hooks/sprintable-grok.json` (+ `.meta.json`) and
    returns the hooks file path. Raises WorkaroundError with a clear message
    on failure — never leaves a half-written/corrupt hooks file behind (a
    broken global hooks file can affect other tooling that reads
    `$GROK_HOME/hooks/`, per SKILL.md)."""
    plugin_root = plugin_root or _plugin_root()
    grok_home = grok_home or _grok_home()

    source = plugin_root / "hooks" / "hooks.json"
    if not source.exists():
        raise WorkaroundError(f"source hooks.json not found: {source}")

    raw = source.read_text()
    patched = raw.replace("${GROK_PLUGIN_ROOT}", str(plugin_root))
    try:
        parsed = json.loads(patched)
    except json.JSONDecodeError as exc:
        raise WorkaroundError(f"patched hooks.json failed to parse, not writing: {exc}") from exc

    hooks_dir = grok_home / "hooks"
    hooks_dir.mkdir(parents=True, exist_ok=True)

    hooks_target = hooks_dir / "sprintable-grok.json"
    hooks_target.write_text(json.dumps(parsed, indent=2) + "\n")

    meta_target = hooks_dir / "sprintable-grok.meta.json"
    meta = {
        "managed_by": "sprintable-grok plugin's configure skill — do not hand-edit",
        "workaround_for": "grok plugin-hooks discovery gap (grok 1.0.0, see plugin README)",
        "workaround_version": WORKAROUND_VERSION,
        "plugin_root": str(plugin_root),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    meta_target.write_text(json.dumps(meta, indent=2) + "\n")

    return hooks_target


def main() -> int:
    try:
        target = install_hooks_workaround()
    except WorkaroundError as exc:
        print(f"install_hooks_workaround: FAILED — {exc}", file=sys.stderr)
        return 1
    print(f"install_hooks_workaround: wrote {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
