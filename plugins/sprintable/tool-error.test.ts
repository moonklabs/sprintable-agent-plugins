/**
 * story #3405 — server.ts를 직접 import할 수 없어(mcp.connect()·SSE dial-out이 모듈 로드
 * 시점 부작용) 공용 catch의 실제 동작은 이 파일을 통해서만 단위테스트할 수 있다(server.ts는
 * 이 함수 하나를 부를 뿐이므로, 이 테스트가 곧 공용 catch의 계약 테스트다).
 */
import { describe, test, expect } from 'bun:test'
import { formatToolError } from './tool-error'

class FakeStructuredError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
    public readonly httpStatus: number,
    public readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'FakeStructuredError'
  }
}

describe('formatToolError — 구조화 에러(StructuredToolError 계약)', () => {
  test('⭐409 CHANNEL_POST_GATE_ALREADY_HELD — code·http_status·detail(holding_draft_id 등)이 전부 파싱 가능한 JSON으로 나간다', () => {
    const err = new FakeStructuredError(
      '이 work item은 다른 초안이 이미 승인 절차 중입니다', 'CHANNEL_POST_GATE_ALREADY_HELD', 409,
      { code: 'CHANNEL_POST_GATE_ALREADY_HELD', message: '이 work item은 다른 초안이 이미 승인 절차 중입니다', holding_draft_id: 'draft-a', holding_channel: 'threads', holding_connection_id: 'conn-a' },
    )
    const result = formatToolError('submit_channel_post_draft', err)
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toEqual({
      tool: 'submit_channel_post_draft',
      code: 'CHANNEL_POST_GATE_ALREADY_HELD',
      message: '이 work item은 다른 초안이 이미 승인 절차 중입니다',
      http_status: 409,
      detail: {
        code: 'CHANNEL_POST_GATE_ALREADY_HELD',
        message: '이 work item은 다른 초안이 이미 승인 절차 중입니다',
        holding_draft_id: 'draft-a', holding_channel: 'threads', holding_connection_id: 'conn-a',
      },
    })
  })

  test('⭐422 CHANNEL_TEXT_TOO_LONG — max_length/current_length가 detail로 그대로 나간다', () => {
    const err = new FakeStructuredError(
      '본문이 한도를 넘었습니다(한도 500자, 현재 640자)', 'CHANNEL_TEXT_TOO_LONG', 422,
      { code: 'CHANNEL_TEXT_TOO_LONG', message: '본문이 한도를 넘었습니다(한도 500자, 현재 640자)', max_length: 500, current_length: 640 },
    )
    const result = formatToolError('create_channel_post_draft', err)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.code).toBe('CHANNEL_TEXT_TOO_LONG')
    expect(parsed.http_status).toBe(422)
    expect(parsed.detail).toEqual({
      code: 'CHANNEL_TEXT_TOO_LONG', message: '본문이 한도를 넘었습니다(한도 500자, 현재 640자)',
      max_length: 500, current_length: 640,
    })
  })

  test('⭐미지 코드(never-seen) — 진단을 지어내지 않는다: code가 원문 그대로 통과하고, 알려진 code처럼 재해석되지 않는다', () => {
    const err = new FakeStructuredError(
      '서버 원문 메시지', 'SOME_BRAND_NEW_CODE_NEVER_SEEN_BEFORE', 409,
      { code: 'SOME_BRAND_NEW_CODE_NEVER_SEEN_BEFORE', message: '서버 원문 메시지' },
    )
    const result = formatToolError('submit_channel_post_draft', err)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.code).toBe('SOME_BRAND_NEW_CODE_NEVER_SEEN_BEFORE')
    expect(parsed.message).toBe('서버 원문 메시지')
    // 알려진 다른 코드로 둔갑하지 않았다는 소극적 확인(known 코드 문자열이 섞여 나오면 안 됨).
    expect(parsed.code).not.toBe('CHANNEL_CONNECTION_NOT_ACTIVE')
    expect(parsed.code).not.toBe('CHANNEL_POST_APPROVER_ROLE_MISSING')
  })

  test('code가 없는 구조화 에러(서버가 code를 안 준 404 등)는 code:null — 지어내지 않는다', () => {
    const err = new FakeStructuredError('draft를 찾을 수 없습니다: x', undefined, 404, undefined)
    const result = formatToolError('submit_channel_post_draft', err)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.code).toBeNull()
    expect(parsed.detail).toBeNull()
    expect(parsed.http_status).toBe(404)
  })
})

describe('formatToolError — 구조화 계약을 안 따르는 에러는 예전과 같은 평문 한 줄(회귀 0)', () => {
  test('일반 Error(httpStatus 없음)는 `tool: message` 평문으로 나간다', () => {
    const result = formatToolError('reply', new Error('work_item is required'))
    expect(result.content[0].text).toBe('reply: work_item is required')
    expect(() => JSON.parse(result.content[0].text)).toThrow()
  })

  test('Error가 아닌 값(문자열 throw 등)도 예전과 동일하게 처리된다', () => {
    const result = formatToolError('reply', 'raw string thrown')
    expect(result.content[0].text).toBe('reply: raw string thrown')
  })
})
