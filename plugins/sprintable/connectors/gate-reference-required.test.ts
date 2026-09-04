/**
 * story #3406 — GateReferenceRequiredError는 instagram.ts/stibee.ts/site_git.ts가 공유하는
 * 클래스라(각 파일 안의 호출부는 freeze로 도달 불가·describe.skip 보존 상태) 여기서 직접
 * 단위테스트한다 — code·message가 예전 `new Error('X requires either...')` 문구와 정확히
 * 같은지(회귀 0), 함수마다 다른 이름이 message에 그대로 실리는지.
 */
import { describe, test, expect } from 'bun:test'
import { GateReferenceRequiredError } from './gate-reference-required'

describe('GateReferenceRequiredError (story #3406)', () => {
  test('code는 GATE_REFERENCE_REQUIRED, httpStatus는 없다(순수 입력검증, 로컬 판정)', () => {
    const err = new GateReferenceRequiredError('publishStibeeCampaign')
    expect(err.code).toBe('GATE_REFERENCE_REQUIRED')
    expect(err.httpStatus).toBeUndefined()
  })

  test('message는 함수명을 그대로 포함해 예전 문구와 동일하다(회귀 0)', () => {
    const err = new GateReferenceRequiredError('publishInstagramPost')
    expect(err.message).toBe(
      'publishInstagramPost requires either gateId or workItemId to check the external_publish gate',
    )
  })

  test('함수마다 다른 functionName이 message에 정확히 반영된다', () => {
    expect(new GateReferenceRequiredError('publishSitePost').message).toContain('publishSitePost')
    expect(new GateReferenceRequiredError('publishStibeeCampaign').message).toContain('publishStibeeCampaign')
  })
})
