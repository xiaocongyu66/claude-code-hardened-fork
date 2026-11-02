import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BunPlugin } from 'bun'
import { createEmbeddedNativesPlugin } from '../../../scripts/embeddedNativesPlugin.ts'

const [payloadPath, outputDir, evidenceDir] = process.argv.slice(2)
assert.ok(payloadPath && isAbsolute(payloadPath))
assert.ok(outputDir && isAbsolute(outputDir))
assert.ok(evidenceDir && isAbsolute(evidenceDir))
const root = fileURLToPath(new URL('../../../', import.meta.url))
const loaderPath = resolve(root, 'src/utils/embeddedNative.ts')
const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
const payload = readFileSync(payloadPath)
const payloadSha256 = sha256(payload)
mkdirSync(outputDir, { recursive: true })
mkdirSync(evidenceDir, { recursive: true })

// 只替换 loader 的精确 debug 导入，隔离 bootstrap，不改变加载路径。
const debugPlugin: BunPlugin = {
  name: 'embedded-smoke-debug-only',
  setup(build) {
    build.onResolve({ filter: /^\.\/debug\.js$/ }, args => {
      if (resolve(args.importer) !== loaderPath) return
      return { path: args.path, namespace: 'embedded-smoke-debug' }
    })
    build.onLoad({ filter: /.*/, namespace: 'embedded-smoke-debug' }, () => ({
      contents:
        'export function logForDebugging(message) { console.error(message) }',
      loader: 'js',
    }))
  },
}

for (const mode of ['valid', 'missing', 'invalid'] as const) {
  const moduleName = `ink-embedded-${mode}-${randomUUID()}`
  const vendorSubPath = moduleName
  const embeddedNatives: Record<string, string> =
    mode === 'missing'
      ? {
          [`${moduleName}-sentinel`]:
            Buffer.from('sentinel').toString('base64'),
        }
      : {
          [moduleName]: (mode === 'valid'
            ? payload
            : Buffer.from('not an ELF')
          ).toString('base64'),
        }
  const outfile = join(outputDir, mode)
  const result = await Bun.build({
    entrypoints: [
      join(root, 'packages/ink-rust/tests/embedded-native-smoke.ts'),
    ],
    target: 'bun',
    minify: true,
    format: 'esm',
    bytecode: true,
    compile: { target: 'bun-linux-x64', outfile },
    define: {
      EMBEDDED_SMOKE: JSON.stringify({
        mode,
        moduleName,
        vendorSubPath,
        payloadSha256,
      }),
    },
    plugins: [createEmbeddedNativesPlugin(embeddedNatives), debugPlugin],
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`Embedded smoke compile failed: ${mode}`)
  }
  writeFileSync(
    join(evidenceDir, `${mode}.build.json`),
    JSON.stringify(
      {
        mode,
        moduleName,
        vendorSubPath,
        sourceSha: process.env.GITHUB_SHA,
        bun: Bun.version,
        target: 'bun-linux-x64',
        minify: true,
        format: 'esm',
        bytecode: true,
        payloadSha256,
        embeddedKeys: Object.keys(embeddedNatives),
        embeddedPayloadHashes: Object.fromEntries(
          Object.entries(embeddedNatives).map(([key, value]) => [
            key,
            sha256(Buffer.from(value, 'base64')),
          ]),
        ),
        binarySha256: sha256(readFileSync(outfile)),
      },
      null,
      2,
    ) + '\n',
  )
}
