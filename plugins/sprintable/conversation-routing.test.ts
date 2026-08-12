/**
 * story #2589 — pins conversation-routing.ts's output for a fixed sample
 * CLAUDE_PROJECT_DIR. The exact same sample + expected value is pinned in
 * hooks/test_hitl_approval_hook.py (Python side) — if you change the
 * substitution regex here, that Python test will fail until you mirror the
 * change there too (and vice versa). This pin IS the parity guard the two
 * processes rely on to agree on a filename with zero inter-process
 * coordination.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { conversationRoutingSuffix, currentConversationFilename } from './conversation-routing'

const SAMPLE_PROJECT_DIR = '/Users/yoonjae/.neoclaw-nwachukwu/state/actors/nwachukwu/workspace'
const EXPECTED_SUFFIX = '_Users_yoonjae__neoclaw-nwachukwu_state_actors_nwachukwu_workspace'

describe('conversation-routing (#2589)', () => {
  const original = process.env.CLAUDE_PROJECT_DIR

  beforeEach(() => {
    delete process.env.CLAUDE_PROJECT_DIR
  })
  afterEach(() => {
    if (original === undefined) delete process.env.CLAUDE_PROJECT_DIR
    else process.env.CLAUDE_PROJECT_DIR = original
  })

  test('pinned: sample CLAUDE_PROJECT_DIR sanitizes to the exact expected suffix', () => {
    process.env.CLAUDE_PROJECT_DIR = SAMPLE_PROJECT_DIR
    expect(conversationRoutingSuffix()).toBe('.' + EXPECTED_SUFFIX)
    expect(currentConversationFilename()).toBe(`current_conversation.${EXPECTED_SUFFIX}.json`)
  })

  test('two different actor workspace dirs never collide on the same filename', () => {
    process.env.CLAUDE_PROJECT_DIR = '/Users/yoonjae/.neoclaw-nwachukwu/state/actors/nwachukwu/workspace'
    const a = currentConversationFilename()
    process.env.CLAUDE_PROJECT_DIR = '/Users/yoonjae/.neoclaw-mirko/state/actors/mirko/workspace'
    const b = currentConversationFilename()
    expect(a).not.toBe(b)
  })

  test('CLAUDE_PROJECT_DIR unset falls back to the legacy unsuffixed filename', () => {
    expect(currentConversationFilename()).toBe('current_conversation.json')
  })
})
