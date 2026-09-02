/**
 * story a98dfbea — Instagram content_package 정본(threads.schema.ts와 동형). 이 커넥터의
 * content 필드는 imageUrl(필수 — Instagram은 순수 텍스트 게시 미지원)·caption(선택). org_config
 * 필드는 없다 — 자격증명(INSTAGRAM_ACCESS_TOKEN/INSTAGRAM_USER_ID)은 threads.schema.ts와
 * 같은 이유로 플러그인 env(스킬로 설정) 전용, apply-time 조직 설정 슬롯이 아니다(M1/M4
 * 설계 경계 동형).
 */
import type { ConnectorDescriptor } from './connector-schema'

export const INSTAGRAM_CONNECTOR_DESCRIPTOR: ConnectorDescriptor = {
  connectorKey: 'instagram',
  version: '1.0.0',
  channel: 'instagram',
  kinds: ['publish'],
  fields: [
    {
      name: 'imageUrl',
      type: 'string',
      description: 'Publicly accessible image URL — Instagram does not support text-only posts.',
      source: 'content',
      required: true,
    },
    {
      name: 'caption',
      type: 'string',
      description: 'Post caption (optional).',
      source: 'content',
      required: false,
    },
  ],
  // INSTAGRAM_ACCESS_TOKEN은 IG 계정이 연결된 Facebook Page의 access token — IG user
  // 토큰이 아니다(instagram.ts 상단 주석 참조, developers.facebook.com 실측).
  requiresEnv: ['INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_USER_ID'],
}
