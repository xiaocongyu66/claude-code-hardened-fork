/**
 * W2 skeleton retained as the public entry point. W5 moved the implementation
 * into `./remote/` (per-provider lanes); this module only re-exports it so the
 * orchestrator and downstream callers keep their existing imports.
 */
export {
  createRemoteMethod,
  DEFAULT_REMOTE_COMPACTION_INSTRUCTIONS,
  isRemoteCompactionEnabled,
  isRemoteMethodAvailable,
  REMOTE_COMPACTION_ENV,
  remoteMethod,
  type RemoteFetch,
  type RemoteLane,
  type RemoteLaneRequest,
  type RemoteLaneResult,
  type RemoteLaneSkip,
  type RemoteLaneSuccess,
  type RemoteLaneTransport,
  type RemoteMethodDeps,
} from './remote/index.js'
