/**
 * story #3317 — connector-schema.ts의 순수 변환 함수들. wire 형상(PO 확定, snake_case)과
 * content/org_config 파생이 정확히 명세대로 나오는지 pin한다.
 */
import { describe, test, expect } from 'bun:test'
import {
  toWireDescriptor,
  contentPropertiesToJsonSchema,
  contentFieldNames,
  orgConfigFields,
  hasSecretLeakInFields,
  type ConnectorDescriptor,
} from './connector-schema'
import { THREADS_CONNECTOR_DESCRIPTOR } from './threads.schema'
import { STIBEE_CONNECTOR_DESCRIPTOR } from './stibee.schema'

const SAMPLE: ConnectorDescriptor = {
  connectorKey: 'sample',
  version: '1.0.0',
  channel: 'sample',
  kinds: ['publish', 'measure'],
  fields: [
    { name: 'text', type: 'string', description: 'body text', source: 'content', required: true, constraints: { maxLength: 500 } },
    { name: 'tags', type: 'array', description: 'optional tags', source: 'content', required: false, constraints: { itemType: 'string' } },
    { name: 'senderEmail', type: 'string', description: 'sender', source: 'org_config', required: true, setupHint: 'set it in org settings' },
    { name: 'create.nested', type: 'string', description: 'nested content field', source: 'content', required: true },
  ],
  requiresEnv: ['SAMPLE_ACCESS_TOKEN'],
}

describe('toWireDescriptor (#3317 — PO 확定 wire 형상)', () => {
  test('camelCase 필드를 snake_case wire 키로 변환한다(connector_key/setup_hint)', () => {
    const wire = toWireDescriptor(SAMPLE)
    expect(wire.connector_key).toBe('sample')
    expect(wire.version).toBe('1.0.0')
    expect(wire.channel).toBe('sample')
    const sender = wire.fields.find((f) => f.name === 'senderEmail')
    expect(sender).toEqual({
      name: 'senderEmail', type: 'string', source: 'org_config', required: true, setup_hint: 'set it in org settings',
    })
  })

  test('constraints/setup_hint 없는 필드는 그 키 자체가 응답에서 빠진다(undefined 노이즈 금지)', () => {
    const wire = toWireDescriptor(SAMPLE)
    const text = wire.fields.find((f) => f.name === 'text')
    expect(text).toEqual({
      name: 'text', type: 'string', source: 'content', required: true, constraints: { maxLength: 500 },
    })
    expect(Object.keys(text!)).not.toContain('setup_hint')
  })

  test('⭐페드루 리뷰(PR#31) — 최상위 requires_env는 이름만(값 0), wire JSON 어디에도 비밀 문자열이 없다', () => {
    const wire = toWireDescriptor(SAMPLE)
    expect(wire.requires_env).toEqual(['SAMPLE_ACCESS_TOKEN'])
    // requires_env가 비어있으면 키 자체가 응답에서 빠진다(undefined 노이즈 금지, 위 pin과 동형).
    const noEnv = toWireDescriptor({ ...SAMPLE, requiresEnv: undefined })
    expect(Object.keys(noEnv)).not.toContain('requires_env')
  })

  test('실 커넥터 정본(threads·stibee) 둘 다 — requiresEnv 이름이 fields에 중복 선언되지 않는다(비밀 유출 0 구조 증명)', () => {
    expect(hasSecretLeakInFields(THREADS_CONNECTOR_DESCRIPTOR)).toBe(false)
    expect(hasSecretLeakInFields(STIBEE_CONNECTOR_DESCRIPTOR)).toBe(false)
  })

  test('⭐페드루 요청(디디군 PR B 그라운딩) — wire 최상위 kinds가 실제 배선된 능력과 일치한다: threads=publish+measure(#3321), stibee=publish만', () => {
    // .sort()는 배열을 제자리에서 바꾼다 — toWireDescriptor가 정본 배열의 사본을 주더라도
    // 습관적으로 원본을 오염시키는 실수를 재현하지 않게, 정렬 없이 Set으로 비교한다.
    expect(new Set(toWireDescriptor(THREADS_CONNECTOR_DESCRIPTOR).kinds)).toEqual(new Set(['publish', 'measure']))
    expect(toWireDescriptor(STIBEE_CONNECTOR_DESCRIPTOR).kinds).toEqual(['publish'])
  })

  test('toWireDescriptor(...).kinds는 정본 배열의 사본이다 — 호출부가 건드려도 정본이 안 바뀐다', () => {
    const wire = toWireDescriptor(THREADS_CONNECTOR_DESCRIPTOR)
    wire.kinds.push('mutated' as never)
    expect(THREADS_CONNECTOR_DESCRIPTOR.kinds).toEqual(['publish', 'measure'])
  })
})

describe('__fixtures__ 픽스처 드리프트 pin (#3317 PR#31 — 디디군 백엔드 PR A 파리티 테스트용)', () => {
  // 페드루 요청: "픽스처 JSON 경로를 PR 본문에 적어두라" — 디디군 쪽 테스트가 이 JSON
  // 파일을 그대로 읽어 백엔드 저장값과 대조한다. 이 파일들이 toWireDescriptor() 라이브
  // 출력과 갈리면(정본이 바뀌었는데 픽스처를 안 갱신) 이 테스트가 잡는다 —
  // connectors/__fixtures__/threads.content-package.json ·
  // connectors/__fixtures__/stibee.content-package.json.
  test('threads.content-package.json == toWireDescriptor(THREADS_CONNECTOR_DESCRIPTOR)', async () => {
    const fixture = await Bun.file(new URL('./__fixtures__/threads.content-package.json', import.meta.url)).json()
    expect(fixture).toEqual(toWireDescriptor(THREADS_CONNECTOR_DESCRIPTOR))
  })

  test('stibee.content-package.json == toWireDescriptor(STIBEE_CONNECTOR_DESCRIPTOR)', async () => {
    const fixture = await Bun.file(new URL('./__fixtures__/stibee.content-package.json', import.meta.url)).json()
    expect(fixture).toEqual(toWireDescriptor(STIBEE_CONNECTOR_DESCRIPTOR))
  })
})

describe('contentPropertiesToJsonSchema (#3317 — 기계적 JSON schema 파생, dot-path 제외)', () => {
  test('non-dotted content 필드만 프로퍼티로 뽑는다 — org_config·dot-path는 제외', () => {
    const result = contentPropertiesToJsonSchema(SAMPLE)
    expect(Object.keys(result.properties).sort()).toEqual(['tags', 'text'])
    expect(result.properties.text).toEqual({ type: 'string', description: 'body text', maxLength: 500 })
    expect(result.properties.tags).toEqual({ type: 'array', description: 'optional tags', items: { type: 'string' } })
  })

  test('required 배열은 required:true인 content 필드만 담는다', () => {
    const result = contentPropertiesToJsonSchema(SAMPLE)
    expect(result.required).toEqual(['text'])
  })
})

describe('contentFieldNames / orgConfigFields', () => {
  test('contentFieldNames는 dot-path 포함 모든 content 필드 이름을 준다', () => {
    expect(contentFieldNames(SAMPLE).sort()).toEqual(['create.nested', 'tags', 'text'])
  })

  test('orgConfigFields는 source=org_config인 필드 객체 전체를 준다', () => {
    const result = orgConfigFields(SAMPLE)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('senderEmail')
    expect(result[0].setupHint).toBe('set it in org settings')
  })
})
