"""Sprintable codex plugin — credential resolution.

Multi-agent isolation lesson carried over from the Claude Code plugin fix
(moonklabs/sprintable-claude-plugin@cdcc0f2): a single shared homedir path
lets N agents on one machine clobber each other's key via configure. That fix's
answer was "explicit override is authoritative, auto-chain only falls back
across paths that already have a .env".

codex has an advantage Claude Code hooks did not: every hook invocation (and
every skill invocation, since skills run in-session) receives `cwd` directly —
there is no skill/server asymmetry to work around. And codex already has a
standard per-agent isolation primitive: CODEX_HOME (operators who run several
codex agents on one box already give each its own CODEX_HOME). So the default
chain anchors on CODEX_HOME instead of a fixed homedir path — multi-agent
isolation happens "for free" for anyone already isolating that way, no plugin-
specific env var required for the common case.

Resolution order:
  1. SPRINTABLE_STATE_DIR   — explicit override, AUTHORITATIVE. If set and its
     .env is missing, credentials are left UNSET (never fall back to another
     tier — falling back would silently read some other agent's key, the exact
     bug this scheme exists to prevent).
  2. <cwd>/.sprintable/.env — project-local override, auto (only used if it
     already exists).
  3. $CODEX_HOME/sprintable/.env — default. CODEX_HOME defaults to ~/.codex if
     unset, matching codex's own resolution.
"""
from __future__ import annotations

import os
from pathlib import Path


def _codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))


def resolve_env_file(cwd: str | None) -> Path:
    override = os.environ.get("SPRINTABLE_STATE_DIR")
    if override:
        return Path(override) / ".env"

    if cwd:
        project_local = Path(cwd) / ".sprintable" / ".env"
        if project_local.exists():
            return project_local

    return _codex_home() / "sprintable" / ".env"


def load_credentials(cwd: str | None) -> dict[str, str]:
    """빈 dict = 미설정(AC2: 조용히 비활성, 에러 아님)."""
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
