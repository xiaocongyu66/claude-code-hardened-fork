import { describe, expect, test } from 'bun:test'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { vendorRootFor } from '../embeddedNative.js'

const root = resolve(sep, 'repo')
const moduleUrl = (relative: string) =>
  pathToFileURL(resolve(root, relative)).href

describe('vendorRootFor', () => {
  test('source layout resolves the checkout vendor directory', () => {
    // Regression: this used to climb three levels from src/utils and land
    // outside the repository, so every dev/vendor native load failed.
    expect(vendorRootFor(moduleUrl('src/utils/embeddedNative.ts'))).toBe(
      resolve(root, 'vendor'),
    )
  })

  test('dist layout keeps vendor inside dist', () => {
    expect(vendorRootFor(moduleUrl('dist/chunks/cli.js'))).toBe(
      resolve(root, 'dist', 'vendor'),
    )
  })
})
