/**
 * Resolve the prebuilt `cch-tui` binary shipped through npm platform packages.
 *
 * Distribution model: the root package lists six optional dependencies
 * (`@cch/tui-<platform>-<arch>`); npm installs only the one whose `os`/`cpu`
 * fields match the host. Each platform package contains:
 *
 *   package.json
 *   bin/cch-tui[.exe]
 *   bin/cch-tui[.exe].sha256   (optional; `<hex>  <filename>` format)
 *
 * This module only *resolves and validates* the binary. It never spawns it —
 * callers decide how to run it. When resolution fails it returns `null` and
 * records an actionable message retrievable via `getTuiBinaryError()`.
 *
 * Supported hosts: linux/darwin/win32 on x64/arm64. Linux builds link glibc;
 * musl hosts are not covered by the current package matrix.
 */

import { createHash } from 'node:crypto'
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { logForDebugging } from './debug.js'

const nodeRequire = createRequire(import.meta.url)

export type TuiPlatformKey =
  | 'linux-x64'
  | 'linux-arm64'
  | 'darwin-x64'
  | 'darwin-arm64'
  | 'windows-x64'
  | 'windows-arm64'

export const SUPPORTED_TUI_PLATFORMS: readonly TuiPlatformKey[] = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'windows-x64',
  'windows-arm64',
]

export interface TuiBinary {
  /** Absolute path to the executable. */
  path: string
  /** Version declared by the platform package (kept in lockstep with the CLI). */
  version: string
}

let lastError: string | null = null

/** Actionable explanation for the most recent `null` result, if any. */
export function getTuiBinaryError(): string | null {
  return lastError
}

/** Map the current Node/Bun host to a platform-package key. */
export function getTuiPlatformKey(): TuiPlatformKey | null {
  let os: 'linux' | 'darwin' | 'windows'
  switch (process.platform) {
    case 'linux':
      os = 'linux'
      break
    case 'darwin':
      os = 'darwin'
      break
    case 'win32':
      os = 'windows'
      break
    default:
      return null
  }

  let arch: 'x64' | 'arm64'
  switch (process.arch) {
    case 'x64':
      arch = 'x64'
      break
    case 'arm64':
      arch = 'arm64'
      break
    default:
      return null
  }

  return `${os}-${arch}` as TuiPlatformKey
}

/** npm package name holding the binary for the current host. */
export function getTuiBinaryPackageName(): string | null {
  const key = getTuiPlatformKey()
  return key ? `@cch/tui-${key}` : null
}

/** Windows binaries use `.exe`; everything else is extension-less. */
function binaryFileName(): string {
  return process.platform === 'win32' ? 'cch-tui.exe' : 'cch-tui'
}

function fail(message: string): null {
  lastError = message
  logForDebugging(`[tuiBinary] ${message}`)
  return null
}

function missingPackageMessage(pkg: string, key: TuiPlatformKey): string {
  return [
    `TUI native binary is unavailable for ${key}: npm package "${pkg}" is not installed.`,
    'The package is an optional dependency, so installs that skip optional deps',
    '(npm --omit=optional / --no-optional, pnpm --no-optional, Yarn optional=false)',
    'or run on an unsupported host will not have it.',
    `Reinstall the CLI (e.g. "npm i -g claude-code-hardened") or install the`,
    `platform package explicitly: "npm i -g ${pkg}".`,
  ].join(' ')
}

function unsupportedHostMessage(): string {
  return [
    `TUI native binary is not packaged for this host (${process.platform}/${process.arch}).`,
    `Supported platforms: ${SUPPORTED_TUI_PLATFORMS.join(', ')}.`,
    'The caller should fall back to the non-native TUI instead.',
  ].join(' ')
}

function unreadablePackageMessage(pkg: string, reason: string): string {
  return `TUI platform package "${pkg}" was found but cannot be read: ${reason}. Reinstall the CLI or the platform package.`
}

function missingBinaryMessage(pkg: string, pkgDir: string): string {
  return `TUI platform package "${pkg}" is installed at ${pkgDir} but contains no binary. The package tarball is incomplete; reinstall it (e.g. "npm i -g ${pkg}").`
}

function notExecutableMessage(path: string): string {
  return `TUI binary "${path}" is not executable. Reinstall the CLI, or run "chmod +x ${path}".`
}

function checksumInvalidMessage(path: string, reason: string): string {
  return `TUI binary "${path}" failed sha256 verification (${reason}). The download is corrupted; reinstall the platform package.`
}

function checksumMismatchMessage(
  path: string,
  expected: string,
  actual: string,
): string {
  return `TUI binary "${path}" failed sha256 verification (expected ${expected}, got ${actual}). The download is corrupted or was tampered with; reinstall the platform package.`
}

/**
 * Resolve and validate the platform binary for the current host.
 *
 * Returns `null` (never throws) when the package or binary is missing, the
 * binary is not executable, or its sidecar `.sha256` does not match. The
 * corresponding actionable text is available from `getTuiBinaryError()`.
 */
export function resolveTuiBinary(): TuiBinary | null {
  lastError = null

  const key = getTuiPlatformKey()
  if (!key) {
    return fail(unsupportedHostMessage())
  }

  const pkg = `@cch/tui-${key}`
  let packageJsonPath: string
  try {
    packageJsonPath = nodeRequire.resolve(`${pkg}/package.json`)
  } catch {
    return fail(missingPackageMessage(pkg, key))
  }

  let rawManifest: unknown
  try {
    rawManifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  } catch (error) {
    return fail(
      unreadablePackageMessage(
        pkg,
        error instanceof Error ? error.message : String(error),
      ),
    )
  }

  const manifest: { version?: unknown } =
    typeof rawManifest === 'object' && rawManifest !== null
      ? (rawManifest as { version?: unknown })
      : {}

  const version =
    typeof manifest.version === 'string' && manifest.version.length > 0
      ? manifest.version
      : 'unknown'

  const pkgDir = dirname(packageJsonPath)
  const fileName = binaryFileName()

  // `bin/` is the published layout; the package root is tolerated for
  // hand-assembled installs.
  const candidates = [join(pkgDir, 'bin', fileName), join(pkgDir, fileName)]
  const binaryPath = candidates.find(path => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  })

  if (!binaryPath) {
    return fail(missingBinaryMessage(pkg, pkgDir))
  }

  if (process.platform !== 'win32') {
    try {
      accessSync(binaryPath, fsConstants.X_OK)
    } catch {
      return fail(notExecutableMessage(binaryPath))
    }
  }

  const checksumPath = `${binaryPath}.sha256`
  if (existsSync(checksumPath)) {
    let expected: string
    try {
      expected =
        readFileSync(checksumPath, 'utf8')
          .trim()
          .split(/\s+/)[0]
          ?.toLowerCase() ?? ''
    } catch (error) {
      return fail(
        checksumInvalidMessage(
          binaryPath,
          error instanceof Error ? error.message : String(error),
        ),
      )
    }

    if (!/^[0-9a-f]{64}$/.test(expected)) {
      return fail(
        checksumInvalidMessage(checksumPath, 'malformed sidecar contents'),
      )
    }

    let actual: string
    try {
      actual = createHash('sha256')
        .update(readFileSync(binaryPath))
        .digest('hex')
    } catch (error) {
      return fail(
        checksumInvalidMessage(
          binaryPath,
          error instanceof Error ? error.message : String(error),
        ),
      )
    }

    if (actual !== expected) {
      return fail(checksumMismatchMessage(binaryPath, expected, actual))
    }
  }

  logForDebugging(`[tuiBinary] resolved ${binaryPath} (v${version})`)
  return { path: binaryPath, version }
}
