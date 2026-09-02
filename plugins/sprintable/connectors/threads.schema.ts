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
  // 'measure' — story #3321(get_threads_insights)이 이미 배선돼 있다(플랫폼 사실: 이
  // 커넥터가 실제로 뭘 할 수 있는지일 뿐, 스토리 착지 여부와 별개로 코드가 있으면 올린다).
  kinds: ['publish', 'measure'],
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
  // THREADS_APP_SECRET은 목록에 없음 — 이 커넥터의 publish 호출(threads.ts)이 실제로 읽는
  // 값은 이 둘뿐(토큰 갱신용 APP_SECRET은 configure-threads 스킬이 같이 저장하지만
  // 커넥터 자체가 소비하지 않는다).
  requiresEnv: ['THREADS_ACCESS_TOKEN', 'THREADS_USER_ID'],
}
