/**
 * story #3317([마케팅자동화·레시피 결함] 발행 입력 스키마) — 커넥터의 "content_package"
 * 계약을 커넥터 자신이 선언하는 정본 타입. PO 확定(2026-09-02, PR#30 후속 채팅) wire
 * 형상을 그대로 따른다:
 *   { connector_key, version, channel, fields: [{ name, source, required, constraints?, setup_hint? }] }
 *
 * 이 정본이 두 자리에 동시에 먹인다(드리프트 원천 차단 — "테스트로 드리프트 0을 잡는다"가
 * 아니라 애초에 갈릴 자리를 안 만든다):
 *   1. `contentPropertiesToJsonSchema()` — source==='content'인 필드만 골라 MCP 도구
 *      inputSchema.properties의 해당 서브셋을 **기계적으로** 만든다(tool-definitions.ts가
 *      이 결과를 그대로 spread — 손으로 따로 안 씀). 오늘은 threads(flat)만 이 경로 —
 *      stibee는 content 필드가 중첩 객체(`create.subject` 등) 안에 있어 flat 파생 대상이
 *      아니다(아래 참고).
 *   2. `describe_connector` MCP 도구가 `toWireDescriptor()`로 그대로 반환 — 백엔드(서버는
 *      에이전트 런타임의 MCP 도구를 못 부른다)가 조직 커넥터 레지스트리에 등록할 때 이
 *      값을 소비한다(story #3317 AC2, 등록 엔드포인트 자체는 디디 별도 그라운딩).
 *
 * source: 'content'(work item이 들고 오는 값 — 텍스트/HTML 등) | 'org_config'(조직 설정에서
 * 합성되는 값 — 발신자·리스트 등, 제품=슬롯·값=조직 원칙). apply 시점에 org_config 필드가
 * 조직 설정에 없으면 명시 경고(AC2) — 이 정본이 "무엇을 검사해야 하는지"의 출처.
 */

export interface ConnectorFieldConstraints {
  maxLength?: number
  minLength?: number
  pattern?: string
  /** type==='array'일 때 원소 타입. */
  itemType?: 'string' | 'number'
}

export interface ConnectorFieldSchema {
  /** stibee처럼 값이 중첩 객체 안에 있으면 dot-path(예: 'create.senderEmail'). */
  name: string
  type: 'string' | 'number' | 'array'
  description: string
  source: 'content' | 'org_config'
  required: boolean
  constraints?: ConnectorFieldConstraints
  /** org_config 필드에서만 의미 있음 — apply-time 경고에 실을 "어디서 채우나". */
  setupHint?: string
}

/** 커넥터가 제공하는 능력 종류 — 플랫폼 사실(무엇을 할 수 있나)이지 조직 규칙이 아니다.
 * 페드루 요청(디디군 PR B 그라운딩, 2026-09-02): 레시피 stage가
 * `capability:{kind:'publish'}`만 선언하고 connector_key를 안 적어도, 서버가 "이
 * kind를 제공하는 등록 커넥터가 있나"를 볼 수 있게 최상위에 둔다. */
export type ConnectorKind = 'publish' | 'measure'

export interface ConnectorDescriptor {
  connectorKey: string
  version: string
  channel: string
  kinds: ConnectorKind[]
  fields: ConnectorFieldSchema[]
  /** 자격증명(토큰·시크릿) 환경변수 **이름만** — 값은 절대 여기 안 실린다. 페드루 리뷰
   * 정정(story #3317, 백엔드 PR A 확定): 이 descriptor는 그대로 서버(조직 커넥터
   * 레지스트리)에 POST되므로, 시크릿은 `fields`(source='org_config')로 선언하면 안 된다
   * — 서버가 값을 저장하려 들 수 있는 자리이기 때문. 자격증명은 플러그인 로컬 .env
   * 전용(story #3311/#3292 M1 경계)이고, 이 목록은 "그 이름의 env가 필요하다"는 존재
   * 신호일 뿐. 판별: describe_connector 결과를 그대로 서버에 POST해도 비밀이 한 글자도
   * 안 넘어가나 — requiresEnv는 이름 문자열뿐이라 그 기준을 구조적으로 만족한다. */
  requiresEnv?: string[]
}

export interface ConnectorDescriptorWire {
  connector_key: string
  version: string
  channel: string
  kinds: ConnectorKind[]
  fields: {
    name: string
    // 페드루 리뷰 정정(PR#31) — type을 wire에 실어야 서버 PUT /connectors/{key}/config가
    // 값 타입(예: listId=number)을 검증할 근거가 생긴다. 이전엔 inputSchema 파생용으로만
    // 쓰고 wire에서 떨어뜨렸었다.
    type: 'string' | 'number' | 'array'
    source: 'content' | 'org_config'
    required: boolean
    constraints?: ConnectorFieldConstraints
    setup_hint?: string
  }[]
  /** 자격증명 env 이름만(값 0) — connectors/connector-schema.ts 상단 ConnectorDescriptor.
   * requiresEnv 주석 참고. */
  requires_env?: string[]
}

/** describe_connector MCP 도구가 그대로 반환하는 wire 형상(PO 확定, snake_case). */
export function toWireDescriptor(descriptor: ConnectorDescriptor): ConnectorDescriptorWire {
  return {
    connector_key: descriptor.connectorKey,
    version: descriptor.version,
    channel: descriptor.channel,
    // 배열 복사(참조 공유 금지) — 호출부가 반환값을 sort()/push() 등으로 건드리면 그
    // 원본 정본(threads.schema.ts 등)이 모듈 스코프에서 영구 오염된다(실제로 이 파일의
    // 테스트 하나가 그렇게 걸려 넘어진 적 있다 — kinds.sort()가 원본을 정렬해버려 이후
    // 테스트가 픽스처와 순서 불일치로 깨졌다).
    kinds: [...descriptor.kinds],
    fields: descriptor.fields.map((f) => ({
      name: f.name,
      type: f.type,
      source: f.source,
      required: f.required,
      ...(f.constraints ? { constraints: f.constraints } : {}),
      ...(f.setupHint ? { setup_hint: f.setupHint } : {}),
    })),
    ...(descriptor.requiresEnv?.length ? { requires_env: descriptor.requiresEnv } : {}),
  }
}

/** 페드루 리뷰 정정 pin용 헬퍼 — requiresEnv에 이름을 올린 자격증명이 fields(특히
 * source='org_config')로도 중복 선언되지 않았는지 구조적으로 확인한다. */
export function hasSecretLeakInFields(descriptor: ConnectorDescriptor): boolean {
  const envNames = new Set(descriptor.requiresEnv ?? [])
  return descriptor.fields.some((f) => envNames.has(f.name))
}

export interface JsonSchemaProperties {
  properties: Record<string, Record<string, unknown>>
  required: string[]
}

/**
 * 정본의 **최상위(non-dotted) content 필드만** MCP 도구 inputSchema.properties 서브셋으로
 * 기계적 변환한다. dot-path(중첩 객체) 필드는 대상이 아니다 — 그런 커넥터(stibee)는
 * inputSchema를 손으로 유지하되, tool-definitions.test.ts가 정본 대비 드리프트를 직접
 * pin한다(같은 TOOL_DEFINITIONS 객체를 대조하므로 사본이 갈릴 여지가 없다).
 */
export function contentPropertiesToJsonSchema(descriptor: ConnectorDescriptor): JsonSchemaProperties {
  const properties: Record<string, Record<string, unknown>> = {}
  const required: string[] = []
  for (const field of descriptor.fields) {
    if (field.source !== 'content' || field.name.includes('.')) continue
    const prop: Record<string, unknown> = { type: field.type, description: field.description }
    if (field.constraints?.maxLength !== undefined) prop.maxLength = field.constraints.maxLength
    if (field.constraints?.minLength !== undefined) prop.minLength = field.constraints.minLength
    if (field.constraints?.pattern !== undefined) prop.pattern = field.constraints.pattern
    if (field.type === 'array' && field.constraints?.itemType) {
      prop.items = { type: field.constraints.itemType }
    }
    properties[field.name] = prop
    if (field.required) required.push(field.name)
  }
  return { properties, required }
}

/** 정본에서 source==='content'인 필드 이름만(dot-path 포함) — 드리프트 pin 테스트가 쓴다. */
export function contentFieldNames(descriptor: ConnectorDescriptor): string[] {
  return descriptor.fields.filter((f) => f.source === 'content').map((f) => f.name)
}

/** 정본에서 source==='org_config'인 필드만 — apply-time 검사(story #3317 AC2)가 쓸 대상. */
export function orgConfigFields(descriptor: ConnectorDescriptor): ConnectorFieldSchema[] {
  return descriptor.fields.filter((f) => f.source === 'org_config')
}
