#!/usr/bin/env node
// Enable the prebuilt TUI platform packages in the root manifest.
//
// Kept as a script (not applied in the repo) because the resulting change
// requires a `bun.lock` regeneration, which CI enforces with
// `--frozen-lockfile`. Run this in the dedicated workflow
// `.github/workflows/tui-lockfile.yml`, commit the produced lockfile, and the
// optionalDependencies become active.
//
// Usage: node scripts/enable-tui-packages.mjs [--revert]

import { readFileSync, writeFileSync } from 'node:fs'

const PLATFORMS = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'windows-x64',
  'windows-arm64',
]
const WORKSPACE_GLOB = 'packages/tui-native/platforms/*'
const revert = process.argv.includes('--revert')

const path = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(readFileSync(path, 'utf8'))

if (!Array.isArray(pkg.workspaces)) {
  throw new Error('package.json has no workspaces array')
}
pkg.optionalDependencies ??= {}

const workspaces = new Set(pkg.workspaces)
if (revert) {
  workspaces.delete(WORKSPACE_GLOB)
  for (const platform of PLATFORMS) {
    delete pkg.optionalDependencies[`@cch/tui-${platform}`]
  }
} else {
  workspaces.add(WORKSPACE_GLOB)
  for (const platform of PLATFORMS) {
    pkg.optionalDependencies[`@cch/tui-${platform}`] = 'workspace:*'
  }
}

pkg.workspaces = [...workspaces]
writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)

console.log(
  revert
    ? 'Removed TUI platform workspaces and optionalDependencies.'
    : `Enabled ${PLATFORMS.length} TUI platform packages. Now run \`bun install --lockfile-only\` and commit bun.lock.`,
)
