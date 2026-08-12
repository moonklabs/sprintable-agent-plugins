/**
 * story #2583 — session injection envelope renderer, vendored into this repo.
 *
 * This plugin (moonklabs/sprintable-agent-plugins) has no dependency on
 * moonklabs/sprintable's connectors/sdk — it's a standalone package with its
 * own bespoke SSE consumption in server.ts, not the shared sprintable_sse SDK.
 * So this is a port, not an import: same render contract as
 * `formatEnvelopeText()` in connectors/sdk/sprintable-sse.ts (that repo),
 * ported by hand because there is no shared module boundary to import across
 * repos. Recon: doc `2583-injection-envelope-recon-20260812` — server.ts's
 * `deliver()` call site was sending bare `content`; sender/event_type/ts were
 * all parsed correctly earlier in `_onEvent` and then silently dropped before
 * reaching the model (the same code-path class as the Dan Irwin
 * misaddressing incident).
 *
 * ⚠️ Repo boundary (moonklabs/sprintable-agent-plugins ↔ moonklabs/sprintable)
 * — this must render byte-identically to the canonical `formatEnvelopeText()`
 * (value order, separators, the "unknown" fallback string). If that function's
 * render rule ever changes, this port must change with it — there is no
 * automated cross-repo guard for this (unlike the #2589 same-repo language-
 * boundary pins), so a manual note here is the only tripwire: check
 * connectors/sdk/sprintable-sse.ts in moonklabs/sprintable before touching
 * this file's output shape.
 */
export type EnvelopeFields = {
  content: string
  senderName: string
  senderId: string
  senderType: string
  eventKind: string
  conversationId: string
  ts: string
}

export function formatEnvelopeText(fields: EnvelopeFields): string {
  const senderName = fields.senderName || fields.senderId || 'unknown'
  const senderType = fields.senderType || 'unknown'
  const eventKind = fields.eventKind || 'unknown'
  const ts = fields.ts || 'unknown'
  const conv = fields.conversationId || 'unknown'
  const header = `[${eventKind}] ${senderName} (${senderType}) · conv=${conv} · ts=${ts}`
  return `${header}\n${fields.content}`
}
