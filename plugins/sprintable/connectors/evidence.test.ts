/**
 * story #3321 — recordEvidence()가 backend/app/routers/evidence.py::EvidenceCreateRequest
 * 실 계약(소스 확認, 추측 0) 그대로의 필드명·경로·인증 헤더를 싣는지 pin한다. 이 모델은
 * extra='ignore'라 오타 필드는 422 없이 조용히 드롭되므로, 정확한 필드명 자체가 이
 * 테스트의 핵심 가치다.
 */
import { describe, test, expect } from 'bun:test'
import { recordEvidence } from './evidence'

describe('recordEvidence (#3321)', () => {
  test('POST /api/v2/evidence로 정확한 필드명(snake_case)을 싣는다', async () => {
    let capturedUrl = ''
    let capturedBody: unknown
    let capturedHeaders: HeadersInit | undefined
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url
      capturedBody = init?.body
      capturedHeaders = init?.headers
      return new Response(JSON.stringify({ id: 'evidence-1' }), { status: 201 })
    }) as unknown as typeof fetch

    const result = await recordEvidence({
      workItemId: 'wi-1', workItemType: 'story', type: 'metric', ref: 'post-99',
      note: '{"views":10}',
      apiUrl: 'https://app.sprintable.ai/', apiKey: 'my-key', fetchImpl,
    })

    expect(result.id).toBe('evidence-1')
    expect(capturedUrl).toBe('https://app.sprintable.ai/api/v2/evidence') // trailing slash 정규화
    expect(JSON.parse(capturedBody as string)).toEqual({
      work_item_id: 'wi-1', work_item_type: 'story', type: 'metric', ref: 'post-99', note: '{"views":10}',
    })
    expect(capturedHeaders).toMatchObject({ Authorization: 'Bearer my-key', 'x-agent-api-key': 'my-key' })
  })

  test('source/note 미지정이면 body에 그 키 자체가 없다(undefined 노이즈 금지)', async () => {
    let capturedBody: unknown
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body
      return new Response(JSON.stringify({ id: 'evidence-2' }), { status: 201 })
    }) as unknown as typeof fetch

    await recordEvidence({
      workItemId: 'wi-1', workItemType: 'story', type: 'metric', ref: 'post-1',
      apiUrl: 'https://app.sprintable.ai', apiKey: 'k', fetchImpl,
    })

    const body = JSON.parse(capturedBody as string)
    expect(Object.keys(body)).not.toContain('source')
    expect(Object.keys(body)).not.toContain('note')
  })

  test('non-2xx는 명시 에러(조용한 통과 금지)', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 422 })) as unknown as typeof fetch
    await expect(
      recordEvidence({
        workItemId: 'wi-1', workItemType: 'story', type: 'metric', ref: 'post-1',
        apiUrl: 'https://app.sprintable.ai', apiKey: 'k', fetchImpl,
      }),
    ).rejects.toThrow('evidence create failed: 422')
  })
})
