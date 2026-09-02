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

export interface ConnectorDescriptor {
  connectorKey: string
  version: string
  channel: string
  fields: ConnectorFieldSchema[]
}

export interface ConnectorDescriptorWire {
  connector_key: string
  version: string
  channel: string
  fields: {
    name: string
    source: 'content' | 'org_config'
    required: boolean
    constraints?: ConnectorFieldConstraints
    setup_hint?: string
  }[]
}

/** describe_connector MCP 도구가 그대로 반환하는 wire 형상(PO 확定, snake_case). */
export function toWireDescriptor(descriptor: ConnectorDescriptor): ConnectorDescriptorWire {
  return {
    connector_key: descriptor.connectorKey,
    version: descriptor.version,
    channel: descriptor.channel,
    fields: descriptor.fields.map((f) => ({
      name: f.name,
      source: f.source,
      required: f.required,
      ...(f.constraints ? { constraints: f.constraints } : {}),
      ...(f.setupHint ? { setup_hint: f.setupHint } : {}),
    })),
  }
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
