import { describe, test, expect } from 'bun:test'
import { sanitizeAttachments, attachmentPlaceholderText } from './attachment-meta'

describe('sanitizeAttachments (#2646)', () => {
  test('maps a well-formed backend attachment object to name/type/size', () => {
    const raw = [
      { url: 'chat/p1/c1/report.pdf', name: 'report.pdf', content_type: 'application/pdf', size: 12345, asset_id: 'x' },
    ]
    expect(sanitizeAttachments(raw)).toEqual([{ name: 'report.pdf', type: 'application/pdf', size: 12345 }])
  })

  test('does not leak the url or asset_id fields', () => {
    const raw = [{ url: 'secret/path', name: 'a.png', content_type: 'image/png', size: 1, asset_id: 'x' }]
    const out = sanitizeAttachments(raw)
    expect(out[0]).not.toHaveProperty('url')
    expect(out[0]).not.toHaveProperty('asset_id')
  })

  test('multiple attachments preserve order', () => {
    const raw = [
      { name: 'a.png', content_type: 'image/png', size: 1 },
      { name: 'b.pdf', content_type: 'application/pdf', size: 2 },
    ]
    expect(sanitizeAttachments(raw).map(a => a.name)).toEqual(['a.png', 'b.pdf'])
  })

  test('not an array: returns empty (no throw)', () => {
    expect(sanitizeAttachments(undefined)).toEqual([])
    expect(sanitizeAttachments(null)).toEqual([])
    expect(sanitizeAttachments('not-an-array')).toEqual([])
    expect(sanitizeAttachments({})).toEqual([])
  })

  test('non-object items in the array are skipped, not crashed on', () => {
    const raw = [null, 'string-item', 42, { name: 'ok.txt', content_type: 'text/plain', size: 3 }]
    expect(sanitizeAttachments(raw)).toEqual([{ name: 'ok.txt', type: 'text/plain', size: 3 }])
  })

  test('missing/malformed fields fall back to safe defaults instead of throwing', () => {
    const raw = [{}, { name: 123, content_type: null, size: 'not-a-number' }]
    expect(sanitizeAttachments(raw)).toEqual([
      { name: 'attachment', type: 'application/octet-stream', size: 0 },
      { name: 'attachment', type: 'application/octet-stream', size: 0 },
    ])
  })
})

describe('attachmentPlaceholderText (#2646)', () => {
  test('singular for exactly one attachment', () => {
    expect(attachmentPlaceholderText([{ name: 'a', type: 't', size: 1 }])).toBe('(1 attachment)')
  })

  test('plural for multiple attachments', () => {
    expect(
      attachmentPlaceholderText([
        { name: 'a', type: 't', size: 1 },
        { name: 'b', type: 't', size: 1 },
      ]),
    ).toBe('(2 attachments)')
  })
})
