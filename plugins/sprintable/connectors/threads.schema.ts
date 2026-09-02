/**
 * story #3317 — Threads content_package 정본. 유일한 content 필드(text)와 그 규격
 * (500자, doc threads-publish-channel-onboarding §4)이 SSOT — tool-definitions.ts의
 * publish_threads_post inputSchema.text가 이 정본에서 기계적으로 파생된다
 * (contentPropertiesToJsonSchema). org_config 필드는 없다 — 이 커넥터의 자격증명
 * (THREADS_ACCESS_TOKEN/THREADS_USER_ID)은 플러그인 env(스킬로 설정)에 살지 apply-time
 * 조직 설정 슬롯이 아니다(M1 설계 경계, story #3311).
 */
import type { ConnectorDescriptor } from './connector-schema'

export const THREADS_CONNECTOR_DESCRIPTOR: ConnectorDescriptor = {
  connectorKey: 'threads',
  version: '1.0.0',
  channel: 'threads',
  fields: [
    {
      name: 'text',
      type: 'string',
      description: 'Post text, max 500 characters.',
      source: 'content',
      required: true,
      constraints: { maxLength: 500 },
    },
  ],
}
