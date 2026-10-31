import { beforeEach, describe, expect, test } from 'bun:test'
import {
  __getEventQueueLengthForTesting,
  __MAX_QUEUED_EVENTS_FOR_TESTING,
  _resetForTesting,
  logEvent,
  logEventAsync,
} from '../index.js'

describe('analytics event queue cap', () => {
  beforeEach(() => {
    _resetForTesting()
  })

  test('drops the oldest events once the cap is exceeded', () => {
    const overflow = 25
    for (let i = 0; i < __MAX_QUEUED_EVENTS_FOR_TESTING + overflow; i += 1) {
      logEvent('test_event', { i })
    }
    expect(__getEventQueueLengthForTesting()).toBe(
      __MAX_QUEUED_EVENTS_FOR_TESTING,
    )
  })

  test('async events share the same bounded queue', async () => {
    const overflow = 10
    for (let i = 0; i < __MAX_QUEUED_EVENTS_FOR_TESTING + overflow; i += 1) {
      await logEventAsync('test_event_async', { i })
    }
    expect(__getEventQueueLengthForTesting()).toBe(
      __MAX_QUEUED_EVENTS_FOR_TESTING,
    )
  })
})
