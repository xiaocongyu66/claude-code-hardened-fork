/** One abort waiter per active read, never reactions on a stream-long promise. */
export function readUntilAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<{ kind: 'next'; result: IteratorResult<T> } | { kind: 'gate' }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve({ kind: 'gate' })
      return
    }
    let active = true
    const finish = (): boolean => {
      if (!active) return false
      active = false
      signal.removeEventListener('abort', onAbort)
      return true
    }
    const onAbort = () => {
      if (finish()) resolve({ kind: 'gate' })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      // Both handlers stay attached to abandoned reads, absorbing late failure.
      // They cannot win again after abort, and no stream-long gate retains them.
      Promise.resolve(iterator.next()).then(
        result => {
          if (finish()) resolve({ kind: 'next', result })
        },
        error => {
          if (finish()) reject(error)
        },
      )
    } catch (error) {
      if (finish()) reject(error)
    }
  })
}
