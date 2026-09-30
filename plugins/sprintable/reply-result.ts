/**
 * story #4430 — what the `reply` tool tells the agent after its message was posted.
 *
 * The backend send answer carries `delivery = {withheld_count, reason, conversation_type?}` when participants of the
 * conversation blocked the sender (a count, never who). Before this the tool always said `sent`, so a blocked message
 * was a quiet success — a 1:1 between two agents was lost that way for two months.
 *
 * Wording (Yuna, via PO 16:49Z): the first line stays `sent` on its own (the text was posted; callers that check the first
 * line keep working). Only when something was withheld, a second line with the fixed prefix `not delivered`:
 *   - 1:1   → `not delivered: the recipient has blocked this sender`
 *   - group → `not delivered to {n} recipient(s): they have blocked this sender`
 * No reason code in the text (the fixed prefix is the machine hook). English only (tool results are en by default).
 * Without a conversation type the group line is used — it stays true for any count.
 */
export function replyResultText(answer: unknown): string {
  const delivery = (answer as { delivery?: unknown } | null)?.delivery as
    | { withheld_count?: unknown; conversation_type?: unknown }
    | undefined
  const n = typeof delivery?.withheld_count === 'number' ? delivery.withheld_count : 0
  if (!Number.isInteger(n) || n <= 0) return 'sent'
  if (delivery?.conversation_type === 'dm') return 'sent\nnot delivered: the recipient has blocked this sender'
  return `sent\nnot delivered to ${n} recipient(s): they have blocked this sender`
}
