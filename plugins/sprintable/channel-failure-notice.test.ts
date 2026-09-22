/**
 * [SID:4026] channel-failure-notice.ts — 채널 안 붙을 때 «1회만» 알리는 상태 판정.
 * AC1 테스트: 빈 키 → 알림 1 · 401 연속 3회 → 알림 1 · 복구 뒤 재실패 → 알림 1.
 */
import { describe, test, expect } from 'bun:test'
import { nextFailureNotice, channelDownMessage, ChannelNoticeGate } from './channel-failure-notice'

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

describe('ChannelNoticeGate (초기화 큐잉·PO 조건1)', () => {
  test('초기화 전 알림은 큐잉·markInitialized에서 한 번에 flush', () => {
    const out: string[] = []
    const g = new ChannelNoticeGate((r) => out.push(r))
    g.notice('no-key')
    expect(out).toEqual([]) // 초기화 전 → 안 나감(큐잉)
    g.markInitialized()
    expect(out).toEqual(['no-key']) // 초기화 → flush
  })

  test('이미 초기화된 뒤(markInitialized 선행)면 notice가 즉시 emit', () => {
    const out: string[] = []
    const g = new ChannelNoticeGate((r) => out.push(r))
    g.markInitialized() // «놓친 초기화» 시나리오 = 대입 전 이미 init
    g.notice('no-key')
    expect(out).toEqual(['no-key']) // 큐잉 없이 즉시
  })

  test('markInitialized 멱등 — 두 번째는 재flush 안 함', () => {
    const out: string[] = []
    const g = new ChannelNoticeGate((r) => out.push(r))
    g.notice('HTTP 401')
    g.markInitialized()
    g.markInitialized() // 두 번째 호출
    expect(out).toEqual(['HTTP 401']) // 한 번만
    expect(g.isInitialized).toBe(true)
  })

  test('같은 사유 반복은 큐잉 단계에서도 1회만', () => {
    const out: string[] = []
    const g = new ChannelNoticeGate((r) => out.push(r))
    g.notice('HTTP 401')
    g.notice('HTTP 401')
    g.notice('HTTP 401')
    g.markInitialized()
    expect(out).toEqual(['HTTP 401'])
  })

  test('clear 뒤 같은 사유 재실패는 다시 1회(초기화 상태)', () => {
    const out: string[] = []
    const g = new ChannelNoticeGate((r) => out.push(r))
    g.markInitialized()
    g.notice('HTTP 401')
    g.clear() // 연결 성공
    g.notice('HTTP 401') // 재실패
    expect(out).toEqual(['HTTP 401', 'HTTP 401'])
  })
})
