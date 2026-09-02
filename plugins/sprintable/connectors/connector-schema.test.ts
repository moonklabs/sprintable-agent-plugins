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
  type ConnectorDescriptor,
} from './connector-schema'

const SAMPLE: ConnectorDescriptor = {
  connectorKey: 'sample',
  version: '1.0.0',
  channel: 'sample',
  fields: [
    { name: 'text', type: 'string', description: 'body text', source: 'content', required: true, constraints: { maxLength: 500 } },
    { name: 'tags', type: 'array', description: 'optional tags', source: 'content', required: false, constraints: { itemType: 'string' } },
    { name: 'senderEmail', type: 'string', description: 'sender', source: 'org_config', required: true, setupHint: 'set it in org settings' },
    { name: 'create.nested', type: 'string', description: 'nested content field', source: 'content', required: true },
  ],
}

describe('toWireDescriptor (#3317 — PO 확定 wire 형상)', () => {
  test('camelCase 필드를 snake_case wire 키로 변환한다(connector_key/setup_hint)', () => {
    const wire = toWireDescriptor(SAMPLE)
    expect(wire.connector_key).toBe('sample')
    expect(wire.version).toBe('1.0.0')
    expect(wire.channel).toBe('sample')
    const sender = wire.fields.find((f) => f.name === 'senderEmail')
    expect(sender).toEqual({
      name: 'senderEmail', source: 'org_config', required: true, setup_hint: 'set it in org settings',
    })
  })

  test('constraints/setup_hint 없는 필드는 그 키 자체가 응답에서 빠진다(undefined 노이즈 금지)', () => {
    const wire = toWireDescriptor(SAMPLE)
    const text = wire.fields.find((f) => f.name === 'text')
    expect(text).toEqual({
      name: 'text', source: 'content', required: true, constraints: { maxLength: 500 },
    })
    expect(Object.keys(text!)).not.toContain('setup_hint')
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
