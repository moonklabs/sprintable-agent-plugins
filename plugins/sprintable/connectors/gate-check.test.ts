/**
 * story #3292 — pins assertGateApproved's approve/reject boundary. This is the
 * chokepoint PO called the AC-critical pin: "게이트 없이는 발송 안 나간다"의 증거.
 * stibee.test.ts pins the same boundary end-to-end (send call happens/doesn't);
 * this file pins the pure decision function in isolation.
 */
import { describe, test, expect } from 'bun:test'
import { assertGateApproved, GateNotApprovedError } from './gate-check'

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

describe('assertGateApproved (#3292)', () => {
  test('status=approved resolves (does not throw)', async () => {
    await expect(
      assertGateApproved('gate-1', 'https://app.sprintable.ai', 'key', fakeFetch(200, { status: 'approved' })),
    ).resolves.toBeUndefined()
  })

  test('status=auto_passed resolves (structurally unreachable for external_publish today, but the check is written generically — pin it anyway)', async () => {
    await expect(
      assertGateApproved('gate-1', 'https://app.sprintable.ai', 'key', fakeFetch(200, { status: 'auto_passed' })),
    ).resolves.toBeUndefined()
  })

  test('status=pending throws GateNotApprovedError — publish must be blocked', async () => {
    await expect(
      assertGateApproved('gate-1', 'https://app.sprintable.ai', 'key', fakeFetch(200, { status: 'pending' })),
    ).rejects.toThrow(GateNotApprovedError)
  })

  test('status=rejected throws GateNotApprovedError', async () => {
    const err = await assertGateApproved(
      'gate-1', 'https://app.sprintable.ai', 'key', fakeFetch(200, { status: 'rejected' }),
    ).catch((e) => e)
    expect(err).toBeInstanceOf(GateNotApprovedError)
    expect((err as GateNotApprovedError).gateStatus).toBe('rejected')
  })

  test('status=voided/held also blocked(허용목록 방식 — approved/auto_passed만 통과, 나머지 전부 차단)', async () => {
    await expect(
      assertGateApproved('gate-1', 'https://app.sprintable.ai', 'key', fakeFetch(200, { status: 'voided' })),
    ).rejects.toThrow(GateNotApprovedError)
    await expect(
      assertGateApproved('gate-1', 'https://app.sprintable.ai', 'key', fakeFetch(200, { status: 'held' })),
    ).rejects.toThrow(GateNotApprovedError)
  })

  test('non-2xx(404 등 — 존재 비노출 규율로 인가 실패도 404) throws, not a silent pass', async () => {
    await expect(
      assertGateApproved('gate-1', 'https://app.sprintable.ai', 'key', fakeFetch(404, {})),
    ).rejects.toThrow('gate lookup failed: 404')
  })

  test('요청이 정확한 GET /api/v2/gates/{id}로 나가고 hitl_approval_hook.py와 동일한 이중 인증 헤더를 싣는다', async () => {
    let capturedUrl = ''
    let capturedHeaders: HeadersInit | undefined
    const spy: typeof fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url
      capturedHeaders = init?.headers
      return new Response(JSON.stringify({ status: 'approved' }), { status: 200 })
    }) as unknown as typeof fetch

    await assertGateApproved('gate-abc', 'https://app.sprintable.ai/', 'my-key', spy)

    expect(capturedUrl).toBe('https://app.sprintable.ai/api/v2/gates/gate-abc') // trailing slash 정규화 확인
    expect(capturedHeaders).toMatchObject({
      Authorization: 'Bearer my-key',
      'x-agent-api-key': 'my-key',
    })
  })
})
