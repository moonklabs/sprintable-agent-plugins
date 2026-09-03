/**
 * story #3366 — 순수 단위 테스트. 외부 fetch가 전혀 없는 모듈이라 스파이 불필요:
 * assertExternalPublishNotFrozen이 항상·예외 없이 ExternalPublishMovedToPlatformError를
 * 던진다는 것 자체가 "outbound 0건"의 근거다(fetch를 부를 코드 경로가 아예 없다).
 */
import { describe, test, expect } from 'bun:test'
import {
  assertExternalPublishNotFrozen,
  ExternalPublishMovedToPlatformError,
  EXTERNAL_PUBLISH_MOVED_TO_PLATFORM,
} from './publish-freeze'

describe('assertExternalPublishNotFrozen (story #3366 AC1/AC2/AC3/AC5)', () => {
  test('항상 ExternalPublishMovedToPlatformError를 던진다(입력 무관)', () => {
    expect(() => assertExternalPublishNotFrozen('publish_threads_post')).toThrow(
      ExternalPublishMovedToPlatformError,
    )
  })

  test('에러 code는 EXTERNAL_PUBLISH_MOVED_TO_PLATFORM·retryable:false(AC1 — 비재시도)', () => {
    try {
      assertExternalPublishNotFrozen('publish_stibee_campaign')
      throw new Error('unreachable — assertExternalPublishNotFrozen must throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ExternalPublishMovedToPlatformError)
      const e = err as ExternalPublishMovedToPlatformError
      expect(e.code).toBe(EXTERNAL_PUBLISH_MOVED_TO_PLATFORM)
      expect(e.retryable).toBe(false)
      expect(e.toolName).toBe('publish_stibee_campaign')
    }
  })

  test('메시지에 다음 행동(Sprintable 화면에서 상신·승인·발행)이 표시된다(AC5) — 외부 게시 성공으로 오인할 ID·URL은 없다', () => {
    try {
      assertExternalPublishNotFrozen('publish_site_post')
      throw new Error('unreachable')
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('Sprintable')
      expect(message).toContain('상신')
      expect(message).toContain('승인')
      expect(message).toContain('발행')
      expect(message).not.toMatch(/https?:\/\//)
    }
  })

  test('toolName이 달라도(어떤 publish_* 도구든) 항상 얼어붙는다', () => {
    for (const toolName of ['publish_threads_post', 'publish_stibee_campaign', 'publish_instagram_post', 'publish_site_post', 'publish_anything_future']) {
      expect(() => assertExternalPublishNotFrozen(toolName)).toThrow(ExternalPublishMovedToPlatformError)
    }
  })
})
