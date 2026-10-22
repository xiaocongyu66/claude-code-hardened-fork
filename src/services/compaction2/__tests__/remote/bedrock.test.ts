import { describe, expect, test } from 'bun:test'
import {
  BEDROCK_COMPACTION_SKIPPED_REASON,
  buildBedrockConverseCompactionSideRequest,
  isBedrockCompactionLaneAvailable,
  runBedrockCompactionLane,
} from '../../methods/remote/bedrock.js'
import { DEFAULT_COMPACTION_SETTINGS } from '../../contracts.js'
import type { CompactionContext } from '../../contracts.js'

const ctx: CompactionContext = {
  model: 'claude-sonnet-4-6',
  trigger: 'threshold',
  messages: [],
  settings: DEFAULT_COMPACTION_SETTINGS,
  tokenCount: () => 0,
  estimateEntryTokens: () => 0,
  now: () => 0,
}

describe('Bedrock lane skeleton', () => {
  test('requires a region and a capable model', () => {
    expect(
      isBedrockCompactionLaneAvailable({
        model: 'claude-sonnet-4-6',
        region: 'us-east-1',
      }),
    ).toBe(true)
    expect(
      isBedrockCompactionLaneAvailable({
        model: 'claude-sonnet-4-6',
      }),
    ).toBe(false)
    expect(
      isBedrockCompactionLaneAvailable({
        model: 'claude-sonnet-4-5',
        region: 'us-east-1',
      }),
    ).toBe(false)
  })

  test('reports skipped because the Converse transport is unavailable', async () => {
    expect(
      await runBedrockCompactionLane({
        ctx,
        instructions: 'summarize',
        env: { AWS_REGION: 'us-east-1' },
        provider: 'bedrock',
        transport: { model: ctx.model },
      }),
    ).toEqual({ skipped: BEDROCK_COMPACTION_SKIPPED_REASON })
  })

  test('has no side-request builder yet', () => {
    expect(
      buildBedrockConverseCompactionSideRequest({
        ctx,
        instructions: 'summarize',
        env: {},
        provider: 'bedrock',
        transport: { model: ctx.model },
      }),
    ).toBeUndefined()
  })
})
