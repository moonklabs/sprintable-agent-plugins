/**
 * story #4134 AC1 — pass-through 성공(6필드 화이트리스트) + 3경로 사람말 + 미지 code 보존.
 */
import { describe, test, expect } from 'bun:test'
import { getMyChannelConnectionStatus, ChannelConnectionStatusAccessError } from './channel-connection-status'
import { ConnectorHttpError } from './http-error'

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

const BASE_PARAMS = { workItemType: 'story', workItemId: 'story-1', apiUrl: 'https://app.sprintable.ai', apiKey: 'agent-key-1' }

describe('getMyChannelConnectionStatus — 성공 pass-through', () => {
  test('200이면 6필드를 그대로(재해석 0) camelCase로만 옮겨 반환한다', async () => {
    const result = await getMyChannelConnectionStatus({
      ...BASE_PARAMS,
      fetchImpl: fakeFetch(200, {
        connection_id: 'conn-1',
        provider: 'threads',
        status: 'active',
        needs_reauth: false,
        last_verified_at: '2026-09-22T00:00:00+00:00',
        display_name: '브랜드 계정',
      }),
    })
    expect(result).toEqual({
      connectionId: 'conn-1',
      provider: 'threads',
      status: 'active',
      needsReauth: false,
      lastVerifiedAt: '2026-09-22T00:00:00+00:00',
      displayName: '브랜드 계정',
    })
  })

  test('필드 화이트리스트 뮤테이션 pin(AC4 명시) — 백엔드 응답에 낯선 필드가 섞여도(자격 유출 등) 결과 객체엔 절대 안 실린다', async () => {
    const result = await getMyChannelConnectionStatus({
      ...BASE_PARAMS,
      fetchImpl: fakeFetch(200, {
        connection_id: 'conn-1',
        provider: 'threads',
        status: 'active',
        needs_reauth: false,
        last_verified_at: null,
        display_name: null,
        // 실측 BE 계약엔 없는 필드 — 명시 필드매핑(스프레드 아님)이라면 이게 안 실려야 한다.
        encrypted_access_token: 'SHOULD-NEVER-LEAK',
        account_id: 'external-account-12345',
      }),
    })
    expect(Object.keys(result).sort()).toEqual(
      ['connectionId', 'displayName', 'lastVerifiedAt', 'needsReauth', 'provider', 'status'].sort(),
    )
    expect(JSON.stringify(result)).not.toContain('SHOULD-NEVER-LEAK')
    expect(JSON.stringify(result)).not.toContain('external-account-12345')
  })

  test('요청 URL이 work_item_type/work_item_id를 정확히 인코딩해 싣는다', async () => {
    let calledUrl = ''
    const fetchImpl = (async (url: string) => {
      calledUrl = url
      return new Response(JSON.stringify({
        connection_id: 'c', provider: 'threads', status: 'active',
        needs_reauth: false, last_verified_at: null, display_name: null,
      }), { status: 200 })
    }) as unknown as typeof fetch
    await getMyChannelConnectionStatus({ ...BASE_PARAMS, workItemId: 'work item/with space', fetchImpl })
    expect(calledUrl).toBe(
      'https://app.sprintable.ai/api/v2/events/work-items/story/work%20item%2Fwith%20space/channel-connection',
    )
  })

  test('needs_reauth=true(재인증 필요) 상태도 그대로 통과한다 — 이 도구가 판단을 내리지 않는다', async () => {
    const result = await getMyChannelConnectionStatus({
      ...BASE_PARAMS,
      fetchImpl: fakeFetch(200, {
        connection_id: 'conn-1', provider: 'threads', status: 'revoked',
        needs_reauth: true, last_verified_at: '2026-09-01T00:00:00+00:00', display_name: '브랜드 계정',
      }),
    })
    expect(result.status).toBe('revoked')
    expect(result.needsReauth).toBe(true)
  })
})

describe('getMyChannelConnectionStatus — 3경로 사람말', () => {
  test('CHANNEL_CONNECTION_STAGE_MISMATCH(403) → "이 작업의 발행 단계가 아니에요."', async () => {
    const err = await getMyChannelConnectionStatus({
      ...BASE_PARAMS,
      fetchImpl: fakeFetch(403, { error: { code: 'CHANNEL_CONNECTION_STAGE_MISMATCH' } }),
    }).catch((e) => e)
    expect(err).toBeInstanceOf(ChannelConnectionStatusAccessError)
    expect((err as ChannelConnectionStatusAccessError).code).toBe('CHANNEL_CONNECTION_STAGE_MISMATCH')
    expect((err as Error).message).toBe('이 작업의 발행 단계가 아니에요.')
    expect((err as ChannelConnectionStatusAccessError).httpStatus).toBe(403)
  })

  test('CHANNEL_CONNECTION_CREW_ONLY(403) → "이 레시피 crew가 아니에요."', async () => {
    const err = await getMyChannelConnectionStatus({
      ...BASE_PARAMS,
      fetchImpl: fakeFetch(403, { error: { code: 'CHANNEL_CONNECTION_CREW_ONLY' } }),
    }).catch((e) => e)
    expect((err as Error).message).toBe('이 레시피 crew가 아니에요.')
  })

  test('CHANNEL_CONNECTION_BINDING_NOT_FOUND(404) → "채널 연결이 아직 등록/바인딩되지 않았어요."', async () => {
    const err = await getMyChannelConnectionStatus({
      ...BASE_PARAMS,
      fetchImpl: fakeFetch(404, { error: { code: 'CHANNEL_CONNECTION_BINDING_NOT_FOUND' } }),
    }).catch((e) => e)
    expect((err as Error).message).toBe('채널 연결이 아직 등록/바인딩되지 않았어요.')
    expect((err as ChannelConnectionStatusAccessError).httpStatus).toBe(404)
  })
})

describe('getMyChannelConnectionStatus — 미지 code(§AC2 임의 낙착 금지)', () => {
  test('CHANNEL_CONNECTION_READ_AGENT_ONLY(에이전트 정상 호출에선 사실상 미도달)도 code는 그대로 보존, message는 폴백', async () => {
    const err = await getMyChannelConnectionStatus({
      ...BASE_PARAMS,
      fetchImpl: fakeFetch(403, { error: { code: 'CHANNEL_CONNECTION_READ_AGENT_ONLY' } }),
    }).catch((e) => e)
    expect(err).toBeInstanceOf(ChannelConnectionStatusAccessError)
    expect((err as ChannelConnectionStatusAccessError).code).toBe('CHANNEL_CONNECTION_READ_AGENT_ONLY')
    expect((err as Error).message).toBe('채널 연결 상태를 읽을 수 없어요.')
  })

  test('전혀 새로운 미래 code도 지어낸 전용 문장 없이 code 보존 + 폴백 문장', async () => {
    const err = await getMyChannelConnectionStatus({
      ...BASE_PARAMS,
      fetchImpl: fakeFetch(500, { error: { code: 'CHANNEL_CONNECTION_SOMETHING_NEW' } }),
    }).catch((e) => e)
    expect((err as ChannelConnectionStatusAccessError).code).toBe('CHANNEL_CONNECTION_SOMETHING_NEW')
    expect((err as Error).message).toBe('채널 연결 상태를 읽을 수 없어요.')
  })

  test('code를 파싱할 수 없는 에러 응답(빈 바디 등)은 code를 지어내지 않고 ConnectorHttpError(HTTP_<status>)로 폴백', async () => {
    const fetchImpl = (async () => new Response('not json', { status: 500 })) as unknown as typeof fetch
    const err = await getMyChannelConnectionStatus({ ...BASE_PARAMS, fetchImpl }).catch((e) => e)
    expect(err).toBeInstanceOf(ConnectorHttpError)
    expect((err as ConnectorHttpError).code).toBe('HTTP_500')
  })
})
