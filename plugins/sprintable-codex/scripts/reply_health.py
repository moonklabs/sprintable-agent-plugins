#!/usr/bin/env python3
"""Standalone CLI: print recent reply-health summary as JSON.
Used by the configure skill's no-args status check (A-3, #2567) — surfaces
reply_failed counts that would otherwise sit silently in events.jsonl only.

Usage: python3 reply_health.py [--cwd <path>] [--window-hours <N>]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import reply_health_summary  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", default=None)
    parser.add_argument("--window-hours", type=float, default=24)
    args = parser.parse_args()
    summary = reply_health_summary(args.cwd, window_seconds=args.window_hours * 3600)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
