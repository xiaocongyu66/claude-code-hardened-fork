#!/usr/bin/env node
// Assemble the publishable @cch/tui-<platform>-<arch> packages from CI artifacts.
//
// The CI `native` matrix stages `cch-tui[.exe]` plus a `.sha256` sidecar per
// Cargo triple. This script copies those files into
// `packages/tui-native/platforms/<pkg>/bin/`, verifies the checksum, restores
// the executable bit and stamps the requested version into each manifest.
//
// Accepted stage layouts (the script probes all of them per triple):
//
//   <stage>/<triple>/cch-tui[.exe]                 # stage/tui or vendor/tui
//   <stage>/tui/<triple>/cch-tui[.exe]             # uploaded `stage/` root
//   <stage>/native-<triple>/tui/<triple>/...       # actions/download-artifact root
//
// The operation is idempotent: every `bin/` directory is recreated from
// scratch, so stale binaries from an earlier run never survive. Generated
// binaries are never committed (`packages/tui-native/platforms/*/bin/` is
// gitignored).
//
// Usage:
//   node scripts/assemble-tui-packages.mjs
//   node scripts/assemble-tui-packages.mjs --stage artifacts --version 2.8.4
//   node scripts/assemble-tui-packages.mjs --stage vendor/tui --version v2.8.4
//   node scripts/assemble-tui-packages.mjs --stage artifacts --version 2.8.4 \
//     --sync-root-manifest
//
// `--sync-root-manifest` stamps the root package version and rewrites the six
// `@cch/tui-*` optionalDependencies to the release version. It only affects the
// root tarball produced in this workspace; it deliberately does not touch
// `workspaces`, so the committed `bun.lock` stays valid.

import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLATFORMS_DIR = join(ROOT, 'packages', 'tui-native', 'platforms')
const ROOT_PKG_PATH = join(ROOT, 'package.json')

// Keep this list in sync with scripts/enable-tui-packages.mjs and the docs table.
const PLATFORMS = [
  { key: 'linux-x64', triple: 'x86_64-unknown-linux-gnu' },
  { key: 'linux-arm64', triple: 'aarch64-unknown-linux-gnu' },
  { key: 'darwin-x64', triple: 'x86_64-apple-darwin' },
  { key: 'darwin-arm64', triple: 'aarch64-apple-darwin' },
  { key: 'windows-x64', triple: 'x86_64-pc-windows-msvc' },
  { key: 'windows-arm64', triple: 'aarch64-pc-windows-msvc' },
]

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

function usage() {
  console.log(`Usage: node scripts/assemble-tui-packages.mjs [options]

Options:
  --stage <dir>           Directory holding the staged binaries. Defaults to
                          ./stage when present, otherwise ./vendor/tui.
  --version <semver>      Version stamped into the platform manifests.
                          Defaults to the root package version; a leading "v"
                          is accepted and stripped.
  --sync-root-manifest    Also stamp the root package version and point its six
                          @cch/tui-* optionalDependencies at <version>.
  -h, --help              Show this help.
`)
}

const argv = process.argv.slice(2)
const options = {}
let syncRootManifest = false
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--help' || arg === '-h') {
    usage()
    process.exit(0)
  }
  if (arg === '--sync-root-manifest') {
    syncRootManifest = true
    continue
  }
  if (arg === '--stage' || arg === '--version') {
    const value = argv[++i]
    if (!value || value.startsWith('--')) fail(`${arg} requires a value`)
    options[arg.slice(2)] = value
    continue
  }
  fail(`unknown argument: ${arg}`)
}

const defaultStage = existsSync(join(ROOT, 'stage'))
  ? join(ROOT, 'stage')
  : join(ROOT, 'vendor', 'tui')
const stageDir = resolve(ROOT, options.stage ?? defaultStage)

const rootPkg = JSON.parse(readFileSync(ROOT_PKG_PATH, 'utf8'))
const version = (options.version ?? rootPkg.version).replace(/^v/, '')
if (!SEMVER.test(version)) {
  const requested = options.version ?? rootPkg.version
  fail(`invalid version "${requested}" (expected semver)`)
}

const binaryName = key =>
  key.startsWith('windows-') ? 'cch-tui.exe' : 'cch-tui'

function candidateDirs(triple) {
  return [
    join(stageDir, triple),
    join(stageDir, 'tui', triple),
    join(stageDir, `native-${triple}`, 'tui', triple),
    join(stageDir, `native-${triple}`, triple),
  ]
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

// ── Pass 1: locate and validate everything before mutating the tree ──
const plans = []
const errors = []

for (const platform of PLATFORMS) {
  const bin = binaryName(platform.key)
  const tried = candidateDirs(platform.triple).map(dir => join(dir, bin))
  const source = tried.find(file => existsSync(file))
  if (!source) {
    errors.push(
      `missing native binary for ${platform.triple} (${bin}); looked in:\n${tried
        .map(file => `    ${file}`)
        .join('\n')}`,
    )
    continue
  }

  const sidecar = `${source}.sha256`
  if (!existsSync(sidecar)) {
    errors.push(`missing checksum sidecar: ${sidecar}`)
    continue
  }
  const text = readFileSync(sidecar, 'utf8').trim()
  const match = /^([0-9a-f]{64})(?:\s+\*?\S+)?$/i.exec(text)
  if (!match) {
    errors.push(
      `malformed checksum sidecar ${sidecar}: expected "<64 hex>  ${bin}"`,
    )
    continue
  }
  const digest = sha256(source)
  if (match[1].toLowerCase() !== digest) {
    errors.push(
      `checksum mismatch for ${source}: sidecar ${match[1].toLowerCase()}, actual ${digest}`,
    )
    continue
  }

  const pkgDir = join(PLATFORMS_DIR, platform.key)
  const pkgPath = join(pkgDir, 'package.json')
  if (!existsSync(pkgPath)) {
    errors.push(`missing platform manifest: ${pkgPath}`)
    continue
  }
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch (error) {
    errors.push(`invalid JSON in ${pkgPath}: ${error.message}`)
    continue
  }
  const expectedName = `@cch/tui-${platform.key}`
  if (pkg.name !== expectedName) {
    errors.push(
      `${pkgPath} declares name ${JSON.stringify(pkg.name)}, expected ${expectedName}`,
    )
    continue
  }

  plans.push({
    ...platform,
    bin,
    source,
    digest,
    pkgDir,
    pkgPath,
    pkg,
  })
}

if (errors.length > 0) {
  for (const error of errors) console.error(`error: ${error}`)
  console.error(`\n${errors.length} error(s); nothing was modified.`)
  process.exit(1)
}

// ── Pass 2: apply (idempotent) ──
for (const plan of plans) {
  const binDir = join(plan.pkgDir, 'bin')
  rmSync(binDir, { recursive: true, force: true })
  mkdirSync(binDir, { recursive: true })

  const dest = join(binDir, plan.bin)
  copyFileSync(plan.source, dest)
  // GitHub Actions runs on Linux even for the Windows artifacts; the exec bit
  // is what npm records in the tarball and what `resolveTuiBinary()` checks.
  chmodSync(dest, 0o755)

  // Canonicalise the sidecar so the packaged name always matches bin/.
  writeFileSync(
    join(binDir, `${plan.bin}.sha256`),
    `${plan.digest}  ${plan.bin}\n`,
  )

  plan.pkg.version = version
  writeFileSync(plan.pkgPath, `${JSON.stringify(plan.pkg, null, 2)}\n`)

  console.log(
    `✓ @cch/tui-${plan.key} ${version} ← ${plan.triple} (${plan.digest.slice(0, 12)}…)`,
  )
}

if (syncRootManifest) {
  rootPkg.version = version
  rootPkg.optionalDependencies ??= {}
  for (const platform of PLATFORMS) {
    rootPkg.optionalDependencies[`@cch/tui-${platform.key}`] = version
  }
  writeFileSync(ROOT_PKG_PATH, `${JSON.stringify(rootPkg, null, 2)}\n`)
  console.log(
    `✓ root manifest: version ${version}, ${PLATFORMS.length} @cch/tui-* optionalDependencies`,
  )
}

console.log(
  `\nAssembled ${plans.length} platform packages from ${stageDir} (version ${version}).`,
)
if (!syncRootManifest) {
  const stale = PLATFORMS.filter(
    platform => rootPkg.optionalDependencies?.[`@cch/tui-${platform.key}`] !== version,
  )
  if (stale.length > 0) {
    console.log(
      `note: root optionalDependencies are not pinned to ${version}; use --sync-root-manifest before packing the root package.`,
    )
  }
}
