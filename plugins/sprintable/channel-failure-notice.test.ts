/**
 * [SID:4026] channel-failure-notice.ts — 채널 안 붙을 때 «1회만» 알리는 상태 판정.
 * AC1 테스트: 빈 키 → 알림 1 · 401 연속 3회 → 알림 1 · 복구 뒤 재실패 → 알림 1.
 */
import { describe, test, expect } from 'bun:test'
import {
  nextFailureNotice,
  channelDownMessage,
  ChannelNoticeGate,
  checkStartupChannelState,
  startupChannelLine,
} from './channel-failure-notice'

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

// ── [SID:4026 재오픈] 시작 시 상태 → initialize instructions ─────────────────────
// 채널 알림은 클라이언트 등록 전에 도착하면 버려진다(2.1.280 실측). 시작 때 아는 상태는 instructions로.
describe('checkStartupChannelState', () => {
  const resp = (status: number) => new Response('{}', { status })
  const recorder = (r: Response | Error | 'hang') => {
    const calls: { url: string; auth: string | null }[] = []
    const f = ((url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get('authorization') })
      if (r === 'hang') {
        return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
      }
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r)
    }) as unknown as typeof fetch
    return { f, calls }
  }

  test('키 없음 → down(no-key) · 네트워크 호출 0', async () => {
    const { f, calls } = recorder(resp(200))
    expect(await checkStartupChannelState({ apiKey: '', apiUrl: 'https://x', hasWebhook: false, fetchImpl: f }))
      .toEqual({ kind: 'down', reason: 'no-key' })
    expect(calls.length).toBe(0)
  })

  test('401·403 → down(HTTP 401/403) — SSE 거절 사유와 같은 모양', async () => {
    for (const st of [401, 403]) {
      const { f } = recorder(resp(st))
      expect(await checkStartupChannelState({ apiKey: 'k', apiUrl: 'https://x', hasWebhook: false, fetchImpl: f }))
        .toEqual({ kind: 'down', reason: `HTTP ${st}` })
    }
  })

  test('200 → ok · /api/v2/me에 Bearer로 1회', async () => {
    const { f, calls } = recorder(resp(200))
    expect(await checkStartupChannelState({ apiKey: 'k-1', apiUrl: 'https://x', hasWebhook: false, fetchImpl: f }))
      .toEqual({ kind: 'ok' })
    expect(calls).toEqual([{ url: 'https://x/api/v2/me', auth: 'Bearer k-1' }])
  })

  test('5xx·네트워크 오류·시간 초과 → unknown(«죽었다»로 단정하지 않음)', async () => {
    expect(await checkStartupChannelState({ apiKey: 'k', apiUrl: 'https://x', hasWebhook: false, fetchImpl: recorder(resp(503)).f }))
      .toEqual({ kind: 'unknown' })
    expect(await checkStartupChannelState({ apiKey: 'k', apiUrl: 'https://x', hasWebhook: false, fetchImpl: recorder(new Error('net')).f }))
      .toEqual({ kind: 'unknown' })
    const t0 = Date.now()
    expect(await checkStartupChannelState({ apiKey: 'k', apiUrl: 'https://x', hasWebhook: false, fetchImpl: recorder('hang').f, timeoutMs: 50 }))
      .toEqual({ kind: 'unknown' })
    expect(Date.now() - t0).toBeLessThan(1000) // 제한 시간 안에 끝난다(기동을 오래 붙잡지 않음)
  })

  test('웹훅 구성(SSE 의도적 off) → ok · 호출 0', async () => {
    const { f, calls } = recorder(resp(401))
    expect(await checkStartupChannelState({ apiKey: '', apiUrl: 'https://x', hasWebhook: true, fetchImpl: f }))
      .toEqual({ kind: 'ok' })
    expect(calls.length).toBe(0)
  })
})

describe('startupChannelLine', () => {
  test('down → 채널 끊김 문구(사유 코드 포함) · ok → 빈 줄', () => {
    expect(startupChannelLine({ kind: 'down', reason: 'no-key' })).toBe(channelDownMessage('no-key'))
    expect(startupChannelLine({ kind: 'down', reason: 'HTTP 401' })).toContain('(HTTP 401)')
    expect(startupChannelLine({ kind: 'ok' })).toBe('')
  })

  test('unknown → «확인하지 못했어요»(끊겼다고 단정 안 함)', () => {
    const line = startupChannelLine({ kind: 'unknown' })
    expect(line).toContain('확인하지 못했어요')
    expect(line).not.toContain('연결되지 않았어요')
  })
})

describe('ChannelNoticeGate.markDeliveredAtStartup', () => {
  test('시작 때 instructions로 준 사유는 첫 SSE 거절 알림에서 겹치지 않는다', () => {
    const out: string[] = []
    const g = new ChannelNoticeGate((r) => out.push(r))
    g.markDeliveredAtStartup('HTTP 401')
    g.markInitialized()
    g.notice('HTTP 401')
    expect(out).toEqual([])
  })

  test('다른 사유는 그대로 1회 · 연결 성공 뒤 재실패도 1회', () => {
    const out: string[] = []
    const g = new ChannelNoticeGate((r) => out.push(r))
    g.markDeliveredAtStartup('no-key')
    g.markInitialized()
    g.notice('HTTP 403')
    g.clear()
    g.notice('HTTP 401')
    expect(out).toEqual(['HTTP 403', 'HTTP 401'])
  })
})

// server.ts는 import하면 mcp.connect·SSE가 돌아 직접 못 부른다 — 배선은 글자로 잡는다.
describe('server.ts 배선(정적)', () => {
  const src = require('fs').readFileSync(require('path').join(import.meta.dir, 'server.ts'), 'utf8') as string
  test('시작 상태 한 줄을 initialize instructions에 덧붙인다', () => {
    expect(src).toContain('const STARTUP_CHANNEL_STATE = await checkStartupChannelState(')
    expect(src).toMatch(/instructions:[\s\S]{0,400}STARTUP_CHANNEL_LINE/)
  })
  test('시작 때 전달한 사유는 게이트에 표시(겹침 방지)', () => {
    expect(src).toContain("if (STARTUP_CHANNEL_STATE.kind === 'down') _noticeGate.markDeliveredAtStartup(STARTUP_CHANNEL_STATE.reason)")
  })
})
