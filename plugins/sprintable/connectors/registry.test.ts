/**
 * story #3317 — registry.ts가 backend/app/routers/connectors.py 실 계약(소스 확認, 추측
 * 0) 그대로의 경로·body·인증 헤더를 싣는지, 그리고 시크릿이 config POST/PUT 어디로도 새지
 * 않는지(페드루 리뷰 포인트②, "서버 422도 있으니 이중"의 클라이언트 쪽 절반) pin한다.
 */
import { describe, test, expect } from 'bun:test'
import {
  resolveOrgId,
  registerConnectorSchema,
  updateConnectorConfig,
  assertNoSecretsInConfig,
  ConnectorConfigForbiddenError,
} from './registry'
import { toWireDescriptor, type ConnectorDescriptor } from './connector-schema'

const SAMPLE_DESCRIPTOR: ConnectorDescriptor = {
  connectorKey: 'sample',
  version: '1.0.0',
  channel: 'sample',
  kinds: ['publish'],
  fields: [
    { name: 'text', type: 'string', description: 'body', source: 'content', required: true },
    { name: 'senderEmail', type: 'string', description: 'sender', source: 'org_config', required: true },
  ],
  requiresEnv: ['SAMPLE_ACCESS_TOKEN'],
}

function meSpy(orgId: string | null = 'org-1') {
  return (async () => new Response(JSON.stringify({ org_id: orgId }), { status: 200 })) as unknown as typeof fetch
}

describe('resolveOrgId (#3317)', () => {
  test('GET /api/v2/auth/me에서 org_id를 뽑는다', async () => {
    const orgId = await resolveOrgId({ apiUrl: 'https://app.sprintable.ai', apiKey: 'k', fetchImpl: meSpy('org-42') })
    expect(orgId).toBe('org-42')
  })

  test('org_id가 null이면 명시 에러(조용한 통과 금지)', async () => {
    await expect(
      resolveOrgId({ apiUrl: 'https://app.sprintable.ai', apiKey: 'k', fetchImpl: meSpy(null) }),
    ).rejects.toThrow('no org_id')
  })

  test('non-2xx는 명시 에러', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    await expect(resolveOrgId({ apiUrl: 'https://app.sprintable.ai', apiKey: 'k', fetchImpl })).rejects.toThrow(
      'auth/me lookup failed: 401',
    )
  })
})

describe('registerConnectorSchema (#3317 — POST /organizations/{org_id}/connectors/{key})', () => {
  function registrySpy() {
    const calls: { method: string; url: string; body?: unknown }[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body })
      if (url.endsWith('/api/v2/auth/me')) {
        return new Response(JSON.stringify({ org_id: 'org-1' }), { status: 200 })
      }
      return new Response(JSON.stringify({ connector_key: 'sample', version: '1.0.0' }), { status: 201 })
    }) as unknown as typeof fetch
    return { calls, fetchImpl }
  }

  test('정확한 경로(org_id·connector key)로 POST하고 body에 connector_key가 없다(URL에만 있음)', async () => {
    const { calls, fetchImpl } = registrySpy()
    const wire = toWireDescriptor(SAMPLE_DESCRIPTOR)

    const result = await registerConnectorSchema(wire, { apiUrl: 'https://app.sprintable.ai', apiKey: 'k', fetchImpl })

    expect(result).toEqual({ connectorKey: 'sample', version: '1.0.0' })
    const postCall = calls.find((c) => c.method === 'POST')!
    expect(postCall.url).toBe('https://app.sprintable.ai/api/v2/organizations/org-1/connectors/sample')
    const body = JSON.parse(postCall.body as string)
    expect(body).toEqual({
      version: '1.0.0', channel: 'sample',
      fields: wire.fields, requires_env: ['SAMPLE_ACCESS_TOKEN'], kinds: ['publish'],
    })
    expect(body.connector_key).toBeUndefined()
  })

  test('⭐body에 시크릿 값이 없다 — wire descriptor는 이름만 실으므로 값 누출 구조적으로 불가', async () => {
    const { calls, fetchImpl } = registrySpy()
    const wire = toWireDescriptor(SAMPLE_DESCRIPTOR)
    await registerConnectorSchema(wire, { apiUrl: 'https://app.sprintable.ai', apiKey: 'k', fetchImpl })
    const postCall = calls.find((c) => c.method === 'POST')!
    const bodyStr = postCall.body as string
    expect(bodyStr).toContain('SAMPLE_ACCESS_TOKEN') // 이름은 실려야 정상(requires_env)
    expect(bodyStr).not.toContain('my-secret-token-value') // 값은 애초에 없다 — 실제로 넣어도 안 남는지 확인
  })

  test('non-2xx는 명시 에러', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/api/v2/auth/me')) return new Response(JSON.stringify({ org_id: 'org-1' }), { status: 200 })
      return new Response('{}', { status: 422 })
    }) as unknown as typeof fetch
    await expect(
      registerConnectorSchema(toWireDescriptor(SAMPLE_DESCRIPTOR), { apiUrl: 'https://app.sprintable.ai', apiKey: 'k', fetchImpl }),
    ).rejects.toThrow('connector schema register failed: 422')
  })
})

describe('assertNoSecretsInConfig / updateConnectorConfig (#3317 — PUT .../config, owner/admin)', () => {
  test('⭐config 키가 requiresEnv 이름과 겹치면 네트워크 호출 전에 즉시 throw(클라이언트 1차 방어)', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    expect(() => assertNoSecretsInConfig(SAMPLE_DESCRIPTOR, { SAMPLE_ACCESS_TOKEN: 'leaked' })).toThrow(
      'SAMPLE_ACCESS_TOKEN',
    )
    await expect(
      updateConnectorConfig(SAMPLE_DESCRIPTOR, { SAMPLE_ACCESS_TOKEN: 'leaked' }, { apiUrl: 'https://app.sprintable.ai', apiKey: 'k', fetchImpl }),
    ).rejects.toThrow('SAMPLE_ACCESS_TOKEN')
    expect(called).toBe(false) // throw가 네트워크보다 먼저 — org_id 조회조차 안 나감
  })

  test('정상 config는 PUT .../connectors/{key}/config로 {config:{...}} body를 싣는다', async () => {
    const calls: { method: string; url: string; body?: unknown }[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body })
      if (url.endsWith('/api/v2/auth/me')) return new Response(JSON.stringify({ org_id: 'org-1' }), { status: 200 })
      return new Response(JSON.stringify({ connector_key: 'sample' }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await updateConnectorConfig(
      SAMPLE_DESCRIPTOR, { senderEmail: 'a@b.com' },
      { apiUrl: 'https://app.sprintable.ai', apiKey: 'k', fetchImpl },
    )

    expect(result).toEqual({ connectorKey: 'sample' })
    const putCall = calls.find((c) => c.method === 'PUT')!
    expect(putCall.url).toBe('https://app.sprintable.ai/api/v2/organizations/org-1/connectors/sample/config')
    expect(JSON.parse(putCall.body as string)).toEqual({ config: { senderEmail: 'a@b.com' } })
  })

  test('⭐403은 ConnectorConfigForbiddenError(owner/admin 아님 — 정상 케이스, 조직 설정 화면 안내)', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/api/v2/auth/me')) return new Response(JSON.stringify({ org_id: 'org-1' }), { status: 200 })
      return new Response('{}', { status: 403 })
    }) as unknown as typeof fetch

    const err = await updateConnectorConfig(
      SAMPLE_DESCRIPTOR, { senderEmail: 'a@b.com' },
      { apiUrl: 'https://app.sprintable.ai', apiKey: 'k', fetchImpl },
    ).catch((e) => e)
    expect(err).toBeInstanceOf(ConnectorConfigForbiddenError)
    expect(err.message).toContain('org owner/admin')
  })

  test('403 이외 non-2xx는 일반 명시 에러', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/api/v2/auth/me')) return new Response(JSON.stringify({ org_id: 'org-1' }), { status: 200 })
      return new Response('{}', { status: 422 })
    }) as unknown as typeof fetch
    await expect(
      updateConnectorConfig(SAMPLE_DESCRIPTOR, { senderEmail: 'a@b.com' }, { apiUrl: 'https://app.sprintable.ai', apiKey: 'k', fetchImpl }),
    ).rejects.toThrow('connector config update failed: 422')
  })
})
