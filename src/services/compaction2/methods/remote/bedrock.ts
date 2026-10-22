import type { RemoteLaneRequest, RemoteLaneResult } from './index.js'
import { supportsAnthropicServerCompaction } from './anthropic.js'

/**
 * Amazon Bedrock lane skeleton.
 *
 * The reference implementation compacts Converse models
 * (`bedrock-converse-stream`) through a Bedrock Runtime
 * `InvokeModelWithResponseStream` side request carrying the Anthropic Messages
 * body. CCH's existing Bedrock transport is `AnthropicBedrock` (Messages API),
 * not Converse, and it does not expose the raw AWS runtime client to the
 * compaction layer. Reusing it for a Converse side request is therefore not
 * possible without new transport plumbing, so the lane reports `skipped`
 * rather than guessing at an endpoint.
 */

export const BEDROCK_COMPACTION_SKIPPED_REASON =
  'bedrock-converse-transport-unavailable'

export function isBedrockCompactionLaneAvailable(input: {
  model: string
  region?: string
}): boolean {
  if (!input.region || input.region.trim().length === 0) return false
  return supportsAnthropicServerCompaction(input.model)
}

/** Shape a Converse side request would take once a transport is available. */
export interface BedrockConverseCompactionSideRequest {
  modelId: string
  body: Record<string, unknown>
  contentType: 'application/json'
  accept: 'application/json'
}

export function buildBedrockConverseCompactionSideRequest(
  _request: RemoteLaneRequest,
): BedrockConverseCompactionSideRequest | undefined {
  return undefined
}

export async function runBedrockCompactionLane(
  _request: RemoteLaneRequest,
): Promise<RemoteLaneResult> {
  return { skipped: BEDROCK_COMPACTION_SKIPPED_REASON }
}
