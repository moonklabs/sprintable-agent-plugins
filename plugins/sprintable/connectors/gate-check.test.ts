/**
 * story #3292 — pins assertGateApproved's approve/reject boundary. This is the
 * chokepoint PO called the AC-critical pin: "게이트 없이는 발송 안 나간다"의 증거.
 * stibee.test.ts pins the same boundary end-to-end (send call happens/doesn't);
 * this file pins the pure decision function in isolation.
 */
import { describe, test, expect } from 'bun:test'
import {
  assertGateApproved,
  assertGateApprovedForWorkItem,
  resolveLatestGate,
  GateNotApprovedError,
  NoGateFoundError,
} from './gate-check'

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

describe('resolveLatestGate / assertGateApprovedForWorkItem (#3312 AC5 — gate_id 없이 work_item으로 조회)', () => {
  function listFetch(gates: unknown[], status = 200): typeof fetch {
    return (async () => new Response(JSON.stringify(gates), { status })) as unknown as typeof fetch
  }

  test('요청이 정확한 필터+limit=1로 나간다(story #2864 — limit 없으면 무정렬이라 "최신" 보장 안 됨)', async () => {
    let capturedUrl = ''
    let capturedHeaders: HeadersInit | undefined
    const spy: typeof fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url
      capturedHeaders = init?.headers
      return new Response(JSON.stringify([{ id: 'gate-9', status: 'approved', work_item_id: 'wi-1', work_item_type: 'story' }]), { status: 200 })
    }) as unknown as typeof fetch

    await resolveLatestGate('wi-1', 'story', 'external_publish', 'https://app.sprintable.ai/', 'my-key', spy)

    const url = new URL(capturedUrl)
    expect(url.pathname).toBe('/api/v2/gates')
    expect(url.searchParams.get('work_item_id')).toBe('wi-1')
    expect(url.searchParams.get('work_item_type')).toBe('story')
    expect(url.searchParams.get('gate_type')).toBe('external_publish')
    expect(url.searchParams.get('limit')).toBe('1')
    expect(capturedHeaders).toMatchObject({ Authorization: 'Bearer my-key', 'x-agent-api-key': 'my-key' })
  })

  test('gate.status=approved — 정상 통과(resolves)', async () => {
    await expect(
      assertGateApprovedForWorkItem(
        'wi-1', 'story', 'external_publish', 'https://app.sprintable.ai', 'key',
        listFetch([{ id: 'gate-1', status: 'approved', work_item_id: 'wi-1', work_item_type: 'story' }]),
      ),
    ).resolves.toBeUndefined()
  })

  test('gate.status=pending — GateNotApprovedError(gate_id 명시 경로와 동일 판정)', async () => {
    const err = await assertGateApprovedForWorkItem(
      'wi-1', 'story', 'external_publish', 'https://app.sprintable.ai', 'key',
      listFetch([{ id: 'gate-1', status: 'pending', work_item_id: 'wi-1', work_item_type: 'story' }]),
    ).catch((e) => e)
    expect(err).toBeInstanceOf(GateNotApprovedError)
    expect((err as GateNotApprovedError).gateStatus).toBe('pending')
  })

  test('⭐0건 — NoGateFoundError(approve 단계 미발생, "미승인"과는 다른 명시 케이스)', async () => {
    const err = await resolveLatestGate(
      'wi-1', 'story', 'external_publish', 'https://app.sprintable.ai', 'key', listFetch([]),
    ).catch((e) => e)
    expect(err).toBeInstanceOf(NoGateFoundError)
    expect((err as NoGateFoundError).workItemId).toBe('wi-1')
  })

  test('non-2xx(org 스코프 밖 work_item_id → 404 등) 명시 에러, 조용한 통과 금지', async () => {
    await expect(
      resolveLatestGate('wi-other-org', 'story', 'external_publish', 'https://app.sprintable.ai', 'key', listFetch([], 404)),
    ).rejects.toThrow('gate list lookup failed: 404')
  })

  test('id/status/work_item_id/work_item_type을 GateSummary로 매핑한다(snake_case 응답 → camelCase)', async () => {
    const result = await resolveLatestGate(
      'wi-1', 'story', 'external_publish', 'https://app.sprintable.ai', 'key',
      listFetch([{ id: 'gate-42', status: 'approved', designated_approver_id: 'member-1', work_item_id: 'wi-1', work_item_type: 'story' }]),
    )
    expect(result).toEqual({
      id: 'gate-42', status: 'approved', designatedApproverId: 'member-1', workItemId: 'wi-1', workItemType: 'story',
    })
  })
})
