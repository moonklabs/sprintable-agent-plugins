"""story #2583 — session injection envelope renderer.

Ported by hand from connectors/sdk/sprintable_sse.py's format_envelope_text()
in moonklabs/sprintable (a different repo — this package has no dependency on
that SDK, it's a standalone stdio JSON-RPC host). Recon (doc
2583-injection-envelope-recon-20260812) found stop.py's batched-drain reason
was built from `items[0]["content"]` / `it["content"]` alone — sender/event
kind/ts were parsed correctly by sprintable_sse.py's MessageContext and then
dropped once the item went into the local SQLite queue (_common.py had no
columns for them), the same code-path class as the Dan Irwin misaddressing
incident.

⚠️ Repo boundary (moonklabs/sprintable-agent-plugins ↔ moonklabs/sprintable)
— must render byte-identically to the canonical format_envelope_text() (value
order, separators, the "unknown" fallback string). No automated cross-repo
guard for this; check connectors/sdk/sprintable_sse.py before touching this
file's output shape.

⚠️ In-repo copy — this exact file is also vendored byte-identically into
plugins/sprintable-grok/scripts/envelope.py (same install-time packaging
boundary that already keeps sprintable_sse.py as two separate vendored
copies rather than a shared import — each plugin folder is installed
standalone via its own marketplace.json local path). Sync both by hand.
"""
from __future__ import annotations


def format_envelope_text(
    content: str, *, sender_name: str = "", sender_id: str = "", sender_type: str = "",
    event_kind: str = "", ts: str = "", conversation_id: str = "",
) -> str:
    name = sender_name or sender_id or "unknown"
    stype = sender_type or "unknown"
    kind = event_kind or "unknown"
    ts_out = ts or "unknown"
    conv = conversation_id or "unknown"
    header = f"[{kind}] {name} ({stype}) · conv={conv} · ts={ts_out}"
    return f"{header}\n{content}"
