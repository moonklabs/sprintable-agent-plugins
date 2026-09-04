/**
 * story #3317([마케팅자동화·레시피 결함] 발행 입력 스키마) — 플러그인 마지막 조각. 설정
 * 스킬(`/sprintable:configure-threads`·`-stibee`) 실행 끝에 이 커넥터의 content_package
 * 정본을 조직 커넥터 레지스트리에 등록하고, 필요하면 org_config 값을 넣는다.
 *
 * 계약은 backend/app/routers/connectors.py + services/connector_registry.py를 직접
 * 확認(추측 0):
 *   POST /api/v2/organizations/{org_id}/connectors/{key}          — 스키마 upsert.
 *        body: {version, channel, fields, requires_env, kinds} — connector_key는 URL의
 *        {key}뿐, body엔 없음. org 멤버 아무나 호출 가능(owner/admin 불필요 — 페드루 리뷰
 *        포인트①: 설정 스킬을 돌리는 게 에이전트 자신이라 owner/admin 전용이면 첫 호출에서
 *        죽는다).
 *   PUT  /api/v2/organizations/{org_id}/connectors/{key}/config   — org_config 값 병합.
 *        body: {config: {...}} — **owner/admin 전용**(에이전트면 403이 정상 — 그 자리에서
 *        "조직 설정 화면/관리자에게" 안내로 이어받는다).
 *
 * org_id는 URL에 명시해야 하는데 이 플러그인은 자기 org_id를 아직 모른다 — `GET
 * /api/v2/auth/me`(AuthMeResponse.org_id, agent API key 컨텍스트에서도 채워짐, 소스 확認)
 * 로 매번 해소한다(캐싱 0 — 조직 전환 같은 드문 이벤트를 위해 매 호출 확인하는 쪽을 택함,
 * 등록/설정은 빈도가 낮아 비용 무시 가능).
 *
 * 시크릿 방어(페드루 리뷰 포인트②, "서버 422도 있으니 이중"): 서버도 org_config 필드명이
 * token/secret/password/api_key류 패턴이면 등록 자체를 거부하지만, 이 파일은 그와 별개로
 * 클라이언트 쪽에서도 두 겹을 건다 — ① registerConnectorSchema는 connector-schema.ts의
 * hasSecretLeakInFields로 이미 검증된 정본만 받는다(호출부 책임) ② updateConnectorConfig는
 * assertNoSecretsInConfig로 config 키가 requiresEnv 이름과 겹치면 네트워크 호출 전에 즉시
 * 막는다.
 *
 * story #3406(2026-09-04) — 이 파일의 에러들도 전부 `code`(구조화 계약, `../tool-error.ts`)
 * 를 갖는다. 실제 `!res.ok` 지점은 `ConnectorHttpError`(HTTP_<status>)로, 로컬 판정
 * (org_id 없음·시크릿 유출 시도)은 각각 전용 code로.
 */
import type { ConnectorDescriptor, ConnectorDescriptorWire } from './connector-schema'
import { ConnectorHttpError } from './http-error'

export interface RegistryClientConfig {
  apiUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
}

function authHeaders(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}`, 'x-agent-api-key': apiKey, 'Content-Type': 'application/json' }
}

/** story #3406 — auth/me가 2xx인데 org_id가 없는(에이전트 키에 조직 스코프가 없는) 로컬
 * 판정. HTTP 자체는 성공이라 httpStatus는 없다. */
export class AuthMeNoOrgIdError extends Error {
  readonly code = 'AUTH_ME_NO_ORG_ID'

  constructor() {
    super('auth/me returned no org_id — agent API key has no organization scope')
    this.name = 'AuthMeNoOrgIdError'
  }
}

/** GET /api/v2/auth/me → org_id. 캐싱 0(등록/설정은 저빈도 호출이라 매번 확인하는 비용이 싸다). */
export async function resolveOrgId(config: RegistryClientConfig): Promise<string> {
  const fetchImpl = config.fetchImpl ?? fetch
  const res = await fetchImpl(`${config.apiUrl.replace(/\/$/, '')}/api/v2/auth/me`, {
    headers: authHeaders(config.apiKey),
  })
  if (!res.ok) throw new ConnectorHttpError('auth/me lookup', res.status)
  const body = (await res.json()) as { org_id: string | null }
  if (!body.org_id) throw new AuthMeNoOrgIdError()
  return body.org_id
}

export class ConnectorConfigForbiddenError extends Error {
  readonly code = 'CONNECTOR_CONFIG_FORBIDDEN'
  readonly httpStatus = 403

  constructor(public readonly connectorKey: string) {
    super(
      `setting connector config for '${connectorKey}' requires org owner/admin — this agent key is not one. ` +
        'Ask an organization owner/admin to set it from the org settings screen, or run this with an owner/admin agent key.',
    )
    this.name = 'ConnectorConfigForbiddenError'
  }
}

export interface RegisterConnectorSchemaResult {
  connectorKey: string
  version: string
}

/**
 * story #3317 AC — 스키마 upsert. wireDescriptor는 이미 connector-schema.ts::
 * toWireDescriptor()가 만든 것을 그대로 넘긴다(이 함수는 body를 다시 조립하지 않고
 * 그 결과의 필드만 뽑아 쓴다 — 두 곳에서 같은 shape을 손으로 두 번 짓지 않는다).
 */
export async function registerConnectorSchema(
  descriptor: ConnectorDescriptorWire,
  registry: RegistryClientConfig,
): Promise<RegisterConnectorSchemaResult> {
  const orgId = await resolveOrgId(registry)
  const fetchImpl = registry.fetchImpl ?? fetch
  const res = await fetchImpl(
    `${registry.apiUrl.replace(/\/$/, '')}/api/v2/organizations/${orgId}/connectors/${descriptor.connector_key}`,
    {
      method: 'POST',
      headers: authHeaders(registry.apiKey),
      body: JSON.stringify({
        version: descriptor.version,
        channel: descriptor.channel,
        fields: descriptor.fields,
        requires_env: descriptor.requires_env ?? [],
        kinds: descriptor.kinds,
      }),
    },
  )
  if (!res.ok) throw new ConnectorHttpError('connector schema register', res.status)
  const body = (await res.json()) as { connector_key: string; version: string }
  return { connectorKey: body.connector_key, version: body.version }
}

/** story #3406 — assertNoSecretsInConfig의 로컬 판정(네트워크 호출 자체가 없는 순수
 * 입력검증). */
export class ConnectorConfigSecretLeakError extends Error {
  readonly code = 'CONNECTOR_CONFIG_SECRET_LEAK'

  constructor(public readonly leakedKeys: string[]) {
    super(
      `config keys [${leakedKeys.join(', ')}] match requiresEnv credential names — ` +
        'secrets must never be sent as connector config, only stored in the local .env',
    )
    this.name = 'ConnectorConfigSecretLeakError'
  }
}

/**
 * config 키가 이 커넥터의 requiresEnv(자격증명 이름)와 겹치면 네트워크 호출 전에 즉시
 * throw — 서버 422(secret-like 필드명 정규식)와 별개의, 클라이언트 쪽 첫 번째 방어선.
 */
export function assertNoSecretsInConfig(descriptor: ConnectorDescriptor, config: Record<string, unknown>): void {
  const envNames = new Set(descriptor.requiresEnv ?? [])
  const leaked = Object.keys(config).filter((k) => envNames.has(k))
  if (leaked.length > 0) {
    throw new ConnectorConfigSecretLeakError(leaked)
  }
}

export interface UpdateConnectorConfigResult {
  connectorKey: string
}

/**
 * PUT .../connectors/{key}/config — owner/admin 전용. 403은 "이 에이전트 키가 owner/
 * admin이 아니다"의 **정상 신호**(페드루 리뷰) — ConnectorConfigForbiddenError로 구별해
 * 호출부가 "조직 설정 화면/관리자에게" 안내로 이어받을 수 있게 한다.
 */
export async function updateConnectorConfig(
  connectorDescriptor: ConnectorDescriptor,
  config: Record<string, unknown>,
  registry: RegistryClientConfig,
): Promise<UpdateConnectorConfigResult> {
  assertNoSecretsInConfig(connectorDescriptor, config)

  const orgId = await resolveOrgId(registry)
  const fetchImpl = registry.fetchImpl ?? fetch
  const res = await fetchImpl(
    `${registry.apiUrl.replace(/\/$/, '')}/api/v2/organizations/${orgId}/connectors/${connectorDescriptor.connectorKey}/config`,
    {
      method: 'PUT',
      headers: authHeaders(registry.apiKey),
      body: JSON.stringify({ config }),
    },
  )
  if (res.status === 403) throw new ConnectorConfigForbiddenError(connectorDescriptor.connectorKey)
  if (!res.ok) throw new ConnectorHttpError('connector config update', res.status)
  const body = (await res.json()) as { connector_key: string }
  return { connectorKey: body.connector_key }
}
