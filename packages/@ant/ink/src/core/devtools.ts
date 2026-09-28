/**
 * Devtools hook — intentionally a no-op in this fork.
 *
 * Upstream Ink dynamically imports react-devtools-core from here when
 * NODE_ENV === 'development' (see reconciler.ts). This repo never ships that
 * dependency, and the reconciler already handles the import failure path
 * (ERR_MODULE_NOT_FOUND → console.warn). Keeping this module as an explicit
 * no-op preserves that contract without a missing-module resolution in the
 * bundler graph; enabling real devtools would mean installing
 * react-devtools-core and wiring the connect call back in.
 */
export {}
