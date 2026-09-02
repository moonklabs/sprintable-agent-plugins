/**
 * story #3317 — PO 확定 요구: "파생 서브셋이 inputSchema와 드리프트 0을 pin". TOOL_DEFINITIONS
 * (server.ts가 그대로 쓰는 바로 그 배열, 사본 아님)를 직접 import해 대조한다. tool-
 * definitions.ts는 mcp.connect()/SSE dial-out 등 부작용이 전혀 없는 순수 모듈이라(server.ts와
 * 분리한 이유가 이것) 여기서 안전하게 import할 수 있다.
 */
import { describe, test, expect } from 'bun:test'
import { TOOL_DEFINITIONS } from './tool-definitions'
import { THREADS_CONNECTOR_DESCRIPTOR } from './connectors/threads.schema'
import { STIBEE_CONNECTOR_DESCRIPTOR } from './connectors/stibee.schema'
import { contentFieldNames } from './connectors/connector-schema'

function toolByName(name: string) {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === name)
  if (!tool) throw new Error(`tool not found: ${name}`)
  return tool
}

describe('publish_threads_post — content_package 드리프트 0 (기계적 파생)', () => {
  test('THREADS_CONNECTOR_DESCRIPTOR의 content 필드(text)가 inputSchema.properties에 정확히 그 규격으로 존재한다', () => {
    const tool = toolByName('publish_threads_post')
    expect(tool.inputSchema.properties.text).toMatchObject({ type: 'string', maxLength: 500 })
  })

  test('content 필드는 전부 inputSchema.required에도 들어있다(threads의 유일한 content 필드=text, required:true)', () => {
    const tool = toolByName('publish_threads_post')
    for (const name of contentFieldNames(THREADS_CONNECTOR_DESCRIPTOR)) {
      expect(tool.inputSchema.required).toContain(name)
    }
  })
})

describe('publish_stibee_campaign — content_package 드리프트 pin (중첩 객체, 손 유지분 대조)', () => {
  test('STIBEE_CONNECTOR_DESCRIPTOR의 모든 content/org_config dot-path 필드가 실 inputSchema.create.properties에 존재한다', () => {
    const tool = toolByName('publish_stibee_campaign')
    const createProps = (tool.inputSchema.properties.create as { properties: Record<string, unknown> }).properties
    for (const field of STIBEE_CONNECTOR_DESCRIPTOR.fields) {
      if (!field.name.startsWith('create.')) continue
      const key = field.name.slice('create.'.length)
      expect(createProps).toHaveProperty(key)
    }
  })

  test('STIBEE_CONNECTOR_DESCRIPTOR의 html(content, top-level)이 inputSchema.properties.html로 존재한다', () => {
    const tool = toolByName('publish_stibee_campaign')
    expect(tool.inputSchema.properties.html).toBeDefined()
  })

  test('⭐드리프트 재현 — 정본에만 있고 inputSchema엔 없는 필드를 추가하면 이 pin이 RED가 된다(방향성 확인)', () => {
    const tool = toolByName('publish_stibee_campaign')
    const createProps = (tool.inputSchema.properties.create as { properties: Record<string, unknown> }).properties
    // 실측: 정본이 선언하는 dot-path 필드 개수와 실 create.properties 키 개수가 정확히 일치
    // (선언 초과·부족 둘 다 잡는다 — 한쪽만 보면 "선언 안 했는데 inputSchema에만 있는 필드"
    // 같은 반대쪽 드리프트를 놓친다).
    const declaredCreateFieldCount = STIBEE_CONNECTOR_DESCRIPTOR.fields.filter((f) => f.name.startsWith('create.')).length
    expect(Object.keys(createProps)).toHaveLength(declaredCreateFieldCount)
  })
})

describe('describe_connector — 도구 정의 존재·계약', () => {
  test('describe_connector 도구가 등록돼 있고 connector enum이 threads/stibee 둘 다 포함한다', () => {
    const tool = toolByName('describe_connector')
    expect((tool.inputSchema.properties.connector as { enum: string[] }).enum.sort()).toEqual(['stibee', 'threads'])
    expect(tool.inputSchema.required).toEqual(['connector'])
  })
})

describe('get_threads_insights — 도구 정의 존재·계약(#3321)', () => {
  test('get_threads_insights 도구가 등록돼 있고 post_id·work_item이 필수다', () => {
    const tool = toolByName('get_threads_insights')
    expect(tool.inputSchema.required).toEqual(['post_id', 'work_item'])
    expect(tool.inputSchema.properties.post_id).toBeDefined()
    expect(tool.inputSchema.properties.work_item).toBeDefined()
    expect(tool.inputSchema.properties.work_item_type).toBeDefined()
  })
})
