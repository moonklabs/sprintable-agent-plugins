/**
 * story #3406 — ConnectorHttpError가 tool-error.ts의 StructuredToolError 계약(code
 * 필수)을 만족하는지, message 문구가 예전 `new Error(...)` 시절과 그대로인지(회귀 0 —
 * 이 메시지를 파싱하는 기존 테스트가 있다면 깨지면 안 된다) 확認.
 */
import { describe, test, expect } from 'bun:test'
import { ConnectorHttpError } from './http-error'

describe('ConnectorHttpError (story #3406)', () => {
  test('message는 예전 `${action} failed: ${status}` 문구를 그대로 유지한다(회귀 0)', () => {
    const err = new ConnectorHttpError('threads publishing limit lookup', 500)
    expect(err.message).toBe('threads publishing limit lookup failed: 500')
  })

  test('code는 HTTP_<status>로 합성되고 httpStatus는 실측값 그대로다', () => {
    const err = new ConnectorHttpError('stibee create email', 502)
    expect(err.code).toBe('HTTP_502')
    expect(err.httpStatus).toBe(502)
  })

  test('Error 인스턴스다(instanceof 체인 유지 — 기존 호출부의 다른 판별과 공존)', () => {
    const err = new ConnectorHttpError('x', 404)
    expect(err).toBeInstanceOf(Error)
  })
})
