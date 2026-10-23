import { beforeEach, describe, expect, test } from 'bun:test'
import { setIsInteractive } from '../../bootstrap/state.js'
import {
  SDKControlGetContextUsageRequestSchema,
  SDKControlResponseSchema,
} from '../../entrypoints/sdk/controlSchemas.js'
import {
  _resetTaskRegistryForTest,
  recordTaskHandle,
} from '../../services/taskRegistry/taskRegistry.js'
import { drainSdkEvents, enqueueSdkEvent } from '../../utils/sdkEventQueue.js'

const TASK_ID = 'task-tui-1'
const OUTPUT_FILE = '/tmp/task-tui-1.out'
const USAGE = { total_tokens: 42, tool_uses: 2, duration_ms: 1200 }

beforeEach(async () => {
  // enqueueSdkEvent only records in headless mode.
  setIsInteractive(false)
  await _resetTaskRegistryForTest()
  drainSdkEvents()
})

describe('task lifecycle frames', () => {
  test('task_started/task_progress carry canonical fields', () => {
    recordTaskHandle({
      id: TASK_ID,
      type: 'local_agent',
      status: 'running',
      description: 'Explore repo',
      outputFile: OUTPUT_FILE,
    })
    enqueueSdkEvent({
      type: 'system',
      subtype: 'task_started',
      task_id: TASK_ID,
      description: 'Explore repo',
      task_type: 'local_agent',
    })
    enqueueSdkEvent({
      type: 'system',
      subtype: 'task_progress',
      task_id: TASK_ID,
      description: 'Explore repo',
      usage: USAGE,
      summary: 'reading files',
    })

    const frames = drainSdkEvents()

    expect(frames.map(f => f.subtype)).toEqual([
      'task_started',
      'task_progress',
    ])
    for (const frame of frames) {
      expect(frame).toMatchObject({
        type: 'system',
        task_id: TASK_ID,
        task_type: 'local_agent',
        description: 'Explore repo',
        status: 'running',
        output: OUTPUT_FILE,
      })
      expect(frame.session_id).toBeTruthy()
      // The frame must survive NDJSON serialization with the same keys.
      expect(JSON.parse(JSON.stringify(frame))).toMatchObject({
        subtype: frame.subtype,
        task_id: TASK_ID,
        task_type: 'local_agent',
        description: 'Explore repo',
        status: 'running',
        output: OUTPUT_FILE,
      })
    }
    expect(frames[1]).toMatchObject({ summary: 'reading files' })
  })

  test('task_notification closes with terminal status and output', () => {
    recordTaskHandle({
      id: TASK_ID,
      type: 'local_agent',
      status: 'completed',
      description: 'Explore repo',
      outputFile: OUTPUT_FILE,
      exitKind: 'completed',
    })
    enqueueSdkEvent({
      type: 'system',
      subtype: 'task_notification',
      task_id: TASK_ID,
      status: 'completed',
      output_file: OUTPUT_FILE,
      summary: 'done',
    })

    const [frame] = drainSdkEvents()

    expect(frame).toMatchObject({
      type: 'system',
      subtype: 'task_notification',
      task_id: TASK_ID,
      task_type: 'local_agent',
      description: 'Explore repo',
      status: 'completed',
      output: OUTPUT_FILE,
      summary: 'done',
    })
  })
})

describe('get_context_usage control protocol', () => {
  test('request schema accepts the subtype', () => {
    expect(
      SDKControlGetContextUsageRequestSchema().parse({
        subtype: 'get_context_usage',
      }),
    ).toEqual({ subtype: 'get_context_usage' })
  })

  test('success response carries the TUI summary shape', () => {
    const message = {
      type: 'control_response' as const,
      response: {
        subtype: 'success' as const,
        request_id: 'req-1',
        response: {
          context_tokens: 1200,
          window_tokens: 200_000,
          percent: 1,
        },
      },
    }

    expect(SDKControlResponseSchema().parse(message)).toEqual(message)
  })
})
