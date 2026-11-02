import type { PluginBuilder } from 'bun'

// Create a Bun plugin that overrides src/utils/embeddedNatives.gen.ts with
// the target platform's base64 payloads.
export function createEmbeddedNativesPlugin(
  embeddedNatives: Record<string, string>,
) {
  return {
    name: 'embedded-natives',
    setup(build: PluginBuilder) {
      build.onResolve({ filter: /embeddedNatives\.gen(\.ts)?$/ }, args => ({
        path: args.path,
        namespace: 'embedded-natives',
      }))
      build.onLoad({ filter: /.*/, namespace: 'embedded-natives' }, () => ({
        contents: `export const EMBEDDED_NATIVES = ${JSON.stringify(embeddedNatives)};\n`,
        loader: 'js',
      }))
    },
  }
}
