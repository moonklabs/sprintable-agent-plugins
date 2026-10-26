/**
 * story 4788 (INFRA-DIET ③ · PO 10-26) — the plugin tells the server which event types it acts on.
 *
 * The agent stream replays every event after the agent's cursor on every connect. This plugin acts on a few event types only
 * (`inject-allowlist.ts`) and drops the rest before acking, so the agent's cursor stops at the last event it acted on and everything after it came
 * again on every reconnect — prod: 25.9 MB per stream, ≈44 GB a day. With this header the server sends this connection only those types.
 *
 * Dropped events are deliberately NOT acked here: an ack is cumulative and per agent (not per connection), so acking an event this plugin does not act on
 * could also retire an earlier event another connection of the same agent (e.g. the desktop app's `desktop.*` events) has not received yet. A server that
 * knows the header does not send the events in question at all; one that does not behaves as before.
 */
import { INJECTABLE_EVENT_TYPES } from './inject-allowlist'

/**
 * story 4788 (AC3 · PO 10-26) — the `Last-Event-ID` the NEXT connect of this process sends. An event the plugin drops (not on its allow-list) used to leave it where it was, so every reconnect
 * inside a long session (the server ends a stream every few minutes) asked for everything after the last event it acted on and was sent the whole dropped tail again. The header is this
 * connection's own request state — nothing is acked and no other connection is touched — so the dropped events can safely move it. Only forward: a lower or unreadable id changes nothing.
 */
export function advanceLastEventId(current: string, evId: string): string {
  const next = Number(evId)
  if (!evId || !Number.isFinite(next) || next <= 0) return current
  const have = Number(current)
  return current && Number.isFinite(have) && have >= next ? current : evId
}

export const ACCEPT_EVENTS_HEADER = 'X-Sprintable-Accept-Events'

/** the types this plugin acts on, as the header value (sorted: the same bytes on every connect) */
export function acceptEventsHeaderValue(): string {
  return [...INJECTABLE_EVENT_TYPES].sort().join(', ')
}
