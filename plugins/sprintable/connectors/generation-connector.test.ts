/**
 * story #4111 AC1 — pass-through 성공 + 4경로 사람말 + 자격 로그 0.
 */
import { describe, test, expect, spyOn, afterEach } from 'bun:test'
import { getGenerationConnector, GenerationConnectorAccessError } from './generation-connector'
import { ConnectorHttpError } from './http-error'

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

const BASE_PARAMS = { workItemType: 'story', workItemId: 'story-1', apiUrl: 'https://app.sprintable.ai', apiKey: 'agent-key-1' }

describe('getGenerationConnector — 성공 pass-through', () => {
  test('200이면 필드를 그대로(재해석 0) camelCase로만 옮겨 반환한다', async () => {
    const result = await getGenerationConnector({
      ...BASE_PARAMS,
      fetchImpl: fakeFetch(200, {
        provider_key: 'vertex_gemini',
        label: '뭉클랩 기본 연산',
        model_config_json: { model: 'gemini-2.5-pro', temperature: 0.7 },
        credentials: 'super-secret-value',
      }),
    })
    expect(result).toEqual({
      providerKey: 'vertex_gemini',
      label: '뭉클랩 기본 연산',
      modelConfigJson: { model: 'gemini-2.5-pro', temperature: 0.7 },
      credentials: 'super-secret-value',
    })
  })

  test('요청 URL이 work_item_type/work_item_id를 정확히 인코딩해 싣는다', async () => {
    let calledUrl = ''
    const fetchImpl = (async (url: string) => {
      calledUrl = url
      return new Response(JSON.stringify({
        provider_key: 'vertex_gemini', label: 'x', model_config_json: {}, credentials: 'c',
      }), { status: 200 })
    }) as unknown as typeof fetch
    await getGenerationConnector({ ...BASE_PARAMS, workItemId: 'work item/with space', fetchImpl })
    expect(calledUrl).toBe(
      'https://app.sprintable.ai/api/v2/events/work-items/story/work%20item%2Fwith%20space/generation-connector',
    )
  })
})

describe('getGenerationConnector — 4경로 사람말(story #4111 처방①)', () => {
  test('GENERATION_CONNECTOR_STAGE_MISMATCH(403) → "이 작업의 연산 단계가 아니에요."', async () => {
    const err = await getGenerationConnector({
      ...BASE_PARAMS,
      fetchImpl: fakeFetch(403, { error: { code: 'GENERATION_CONNECTOR_STAGE_MISMATCH' } }),
    }).catch((e) => e)
    expect(err).toBeInstanceOf(GenerationConnectorAccessError)
    expect((err as GenerationConnectorAccessError).code).toBe('GENERATION_CONNECTOR_STAGE_MISMATCH')
    expect((err as Error).message).toBe('이 작업의 연산 단계가 아니에요.')
    expect((err as GenerationConnectorAccessError).httpStatus).toBe(403)
  })

  test('GENERATION_CONNECTOR_CREW_ONLY(403) → "이 레시피 crew가 아니에요."', async () => {
    const err = await getGenerationConnector({
      ...BASE_PARAMS,
      fetchImpl: fakeFetch(403, { error: { code: 'GENERATION_CONNECTOR_CREW_ONLY' } }),
    }).catch((e) => e)
    expect((err as Error).message).toBe('이 레시피 crew가 아니에요.')
  })

  test('GENERATION_CONNECTOR_BINDING_NOT_FOUND(404) → "연산 커넥터가 아직 등록/바인딩되지 않았어요."', async () => {
    const err = await getGenerationConnector({
      ...BASE_PARAMS,
      fetchImpl: fakeFetch(404, { error: { code: 'GENERATION_CONNECTOR_BINDING_NOT_FOUND' } }),
    }).catch((e) => e)
    expect((err as Error).message).toBe('연산 커넥터가 아직 등록/바인딩되지 않았어요.')
  })

  test('GENERATION_CONNECTOR_REVOKED(409) → "커넥터가 해지됐어요."', async () => {
    const err = await getGenerationConnector({
      ...BASE_PARAMS,
      fetchImpl: fakeFetch(409, { error: { code: 'GENERATION_CONNECTOR_REVOKED' } }),
    }).catch((e) => e)
    expect((err as Error).message).toBe('커넥터가 해지됐어요.')
    expect((err as GenerationConnectorAccessError).httpStatus).toBe(409)
  })
})

describe('getGenerationConnector — 미지 code(§AC2 임의 낙착 금지)', () => {
  test('GENERATION_CONNECTOR_READ_AGENT_ONLY(에이전트 정상 호출에선 사실상 미도달)도 code는 그대로 보존, message는 폴백', async () => {
    const err = await getGenerationConnector({
      ...BASE_PARAMS,
      fetchImpl: fakeFetch(403, { error: { code: 'GENERATION_CONNECTOR_READ_AGENT_ONLY' } }),
    }).catch((e) => e)
    expect(err).toBeInstanceOf(GenerationConnectorAccessError)
    expect((err as GenerationConnectorAccessError).code).toBe('GENERATION_CONNECTOR_READ_AGENT_ONLY')
    expect((err as Error).message).toBe('연산 커넥터를 읽을 수 없어요.')
  })

  test('전혀 새로운 미래 code도 지어낸 전용 문장 없이 code 보존 + 폴백 문장', async () => {
    const err = await getGenerationConnector({
      ...BASE_PARAMS,
      fetchImpl: fakeFetch(500, { error: { code: 'GENERATION_CONNECTOR_SOMETHING_NEW' } }),
    }).catch((e) => e)
    expect((err as GenerationConnectorAccessError).code).toBe('GENERATION_CONNECTOR_SOMETHING_NEW')
    expect((err as Error).message).toBe('연산 커넥터를 읽을 수 없어요.')
  })

  test('code를 파싱할 수 없는 에러 응답(빈 바디 등)은 code를 지어내지 않고 ConnectorHttpError(HTTP_<status>)로 폴백', async () => {
    const fetchImpl = (async () => new Response('not json', { status: 500 })) as unknown as typeof fetch
    const err = await getGenerationConnector({ ...BASE_PARAMS, fetchImpl }).catch((e) => e)
    expect(err).toBeInstanceOf(ConnectorHttpError)
    expect((err as ConnectorHttpError).code).toBe('HTTP_500')
  })
})

describe('getGenerationConnector — 자격 로그 0(story #4111 처방②)', () => {
  afterEach(() => {
    // eslint 없는 레포지만 스파이는 매 테스트 뒤 반드시 원복(다음 테스트가 실 console을 씀).
  })

  test('성공 경로 — credentials 값이 console.log/error/warn 어디에도 안 찍힌다', async () => {
    const logSpy = spyOn(console, 'log')
    const errorSpy = spyOn(console, 'error')
    const warnSpy = spyOn(console, 'warn')
    try {
      await getGenerationConnector({
        ...BASE_PARAMS,
        fetchImpl: fakeFetch(200, {
          provider_key: 'vertex_gemini', label: 'x', model_config_json: {},
          credentials: 'MARKER-SECRET-abc123',
        }),
      })
      const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
        .flat().map((v) => JSON.stringify(v)).join('\n')
      expect(allLoggedText).not.toContain('MARKER-SECRET-abc123')
    } finally {
      logSpy.mockRestore()
      errorSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  test('실패 경로(에러 detail에 우연히 자격류 문자열이 섞여도) console에 안 찍힌다', async () => {
    const logSpy = spyOn(console, 'log')
    const errorSpy = spyOn(console, 'error')
    const warnSpy = spyOn(console, 'warn')
    try {
      await getGenerationConnector({
        ...BASE_PARAMS,
        fetchImpl: fakeFetch(409, {
          error: { code: 'GENERATION_CONNECTOR_REVOKED', message: 'revoked, was MARKER-SECRET-xyz789' },
        }),
      }).catch(() => {})
      const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
        .flat().map((v) => JSON.stringify(v)).join('\n')
      expect(allLoggedText).not.toContain('MARKER-SECRET-xyz789')
    } finally {
      logSpy.mockRestore()
      errorSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })
})
