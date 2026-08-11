"""Sprintable grok plugin — credential resolution.

Same chain as sprintable-codex (S2, #2557), GROK_HOME substituted for
CODEX_HOME. Grok hands `cwd` to every hook, same symmetry the codex plugin
relies on — no skill/server path-mismatch problem here either.

Resolution order:
  1. SPRINTABLE_STATE_DIR   — explicit override, AUTHORITATIVE. If set and its
     .env is missing, credentials are left UNSET (never fall back to another
     tier — falling back would silently read some other agent's key).
  2. <cwd>/.sprintable/.env — project-local override, auto (only used if it
     already exists).
  3. $GROK_HOME/sprintable/.env ($GROK_HOME defaults to ~/.grok) — default.
"""
from __future__ import annotations

import os
from pathlib import Path


def _grok_home() -> Path:
    return Path(os.environ.get("GROK_HOME", Path.home() / ".grok"))


def resolve_env_file(cwd: str | None) -> Path:
    override = os.environ.get("SPRINTABLE_STATE_DIR")
    if override:
        return Path(override) / ".env"

    if cwd:
        project_local = Path(cwd) / ".sprintable" / ".env"
        if project_local.exists():
            return project_local

    return _grok_home() / "sprintable" / ".env"


def load_credentials(cwd: str | None) -> dict[str, str]:
    """빈 dict = 미설정(AC3: 조용히 비활성, 에러 아님)."""
    env_file = resolve_env_file(cwd)
    if not env_file.exists():
        return {}
    creds: dict[str, str] = {}
    for line in env_file.read_text().splitlines():
        if "=" not in line or line.strip().startswith("#"):
            continue
        key, _, value = line.partition("=")
        creds[key.strip()] = value.strip()
    return creds
