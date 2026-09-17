/**
 * [SID:4026] channel-failure-notice.ts — 채널 안 붙을 때 «1회만» 알리는 상태 판정.
 * AC1 테스트: 빈 키 → 알림 1 · 401 연속 3회 → 알림 1 · 복구 뒤 재실패 → 알림 1.
 */
import { describe, test, expect } from 'bun:test'
import { nextFailureNotice, channelDownMessage } from './channel-failure-notice'

describe('nextFailureNotice', () => {
  test('빈 키 → 알림 1', () => {
    expect(nextFailureNotice('no-key', null)).toEqual({ notify: true, nextLast: 'no-key' })
  })

  test('같은 사유(401) 연속 3회 → 알림은 첫 1회만', () => {
    let last: string | null = null
    const emitted: boolean[] = []
    for (let i = 0; i < 3; i++) {
      const d = nextFailureNotice('HTTP 401', last)
      emitted.push(d.notify)
      last = d.nextLast
    }
    expect(emitted).toEqual([true, false, false])
  })

  test('연결 성공(null) → 해제·알림 X', () => {
    expect(nextFailureNotice(null, 'HTTP 401')).toEqual({ notify: false, nextLast: null })
  })

  test('복구(성공) 뒤 재실패 → 다시 알림 1', () => {
    let last: string | null = 'HTTP 401'
    last = nextFailureNotice(null, last).nextLast // 성공 → 해제(null)
    const d = nextFailureNotice('HTTP 401', last) // 재실패
    expect(d).toEqual({ notify: true, nextLast: 'HTTP 401' })
  })

  test('사유가 바뀌면(401→403) 다시 알림', () => {
    expect(nextFailureNotice('HTTP 403', 'HTTP 401')).toEqual({ notify: true, nextLast: 'HTTP 403' })
  })
})

describe('channelDownMessage', () => {
  test('해요체·사유 포함·비밀 없음', () => {
    const m = channelDownMessage('no-key')
    expect(m).toContain('연결되지 않았어요')
    expect(m).toContain('DM이 자동으로 들어오지 않아요')
    expect(m).toContain('no-key')
    expect(m.endsWith('요.') || m.endsWith(').')).toBe(true)
  })
})
