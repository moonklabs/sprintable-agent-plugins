/**
 * story 4213f6c4 — 자사 사이트(Sprintable API 발행) content_package 정본. site_git.schema.ts
 * 와 거의 동형이나 requiresEnv가 비어있다(Sprintable API 키는 이 플러그인이 이미 갖고
 * 있다 — 별도 GitHub PAT·저장소 좌표가 필요 없다, story #3360 §4). org_config도
 * site_base_url 하나뿐(repo/branch/path_template은 이제 무의미 — 서버가 저장소를
 * 안 건드린다).
 */
import type { ConnectorDescriptor } from './connector-schema'

export const SITE_CONNECTOR_DESCRIPTOR: ConnectorDescriptor = {
  connectorKey: 'site',
  version: '1.0.0',
  channel: 'site',
  kinds: ['publish'],
  fields: [
    {
      name: 'title', type: 'string', description: 'Post title.',
      source: 'content', required: true,
    },
    {
      name: 'body', type: 'string', description: 'Post body, plain markdown.',
      source: 'content', required: true,
    },
    {
      name: 'slug', type: 'string', description: 'URL slug — becomes the published path segment.',
      source: 'content', required: true,
    },
    {
      name: 'lang', type: 'string', description: 'Locale of this post (e.g. "ko").',
      source: 'content', required: true,
    },
    {
      name: 'summary', type: 'string', description: 'Short summary for listing pages — required by the server.',
      source: 'content', required: true,
    },
    {
      name: 'tags', type: 'array', description: 'Optional tags.',
      source: 'content', required: false, constraints: { itemType: 'string' },
    },
    {
      name: 'site_base_url', type: 'string', description: 'Public site base URL for computing the published post URL.',
      source: 'org_config', required: true,
      setupHint: '공개 사이트 주소(예: https://sprintable.ai) — 조직 설정 화면에 등록',
    },
  ],
  // Sprintable API 키(이 플러그인이 이미 보유)만 쓴다 — 별도 자격증명 env 0.
  requiresEnv: [],
}
