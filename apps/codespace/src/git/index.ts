/**
 * Git channel (P3). Public surface for the rest of the portal:
 *
 *   ensureStagingRepo  seeds <volume>/staging.git from the right source
 *   gitBackendPlugin   the Fastify plugin, mounted on its own port (9418)
 *   createRelayWorker  the background push to the forge
 *
 * See README.md in this directory for the development commands.
 */
export { CgiHeadScanner, parseCgiHead, httpMetaVariable, type CgiHead } from "./cgi.js";
// `db.ts` is gone in V1: the database is the portal's own (`db/client.ts`).
export {
  createForgejoForge,
  createGithubForge,
  createUnconfiguredGithubForge,
  ForgeUnconfiguredError,
  INSTALLATION_TOKEN_TTL_MS,
  TOKEN_RENEWAL_MARGIN_MS,
  UNCONFIGURED_GITHUB_MESSAGE,
  type Forge,
  type ForgejoOptions,
  type GithubAppApi,
  type GithubOptions,
} from "./forge.js";
export { git, gitAuthEnv, gitBare, redactSecrets, GitError } from "./gitRunner.js";
export {
  authorizeSource,
  backendEnv,
  createGitServer,
  gitBackendPlugin,
  ipInCidr,
  normalizeIp,
  requestedService,
  serviceAllowed,
  startGitServer,
  DEFAULT_CLIENT_CIDR,
  DEFAULT_GIT_HOST,
  DEFAULT_GIT_PORT,
  type GitBackendOptions,
  type GitServerOptions,
} from "./httpBackend.js";
export {
  createPushEventStore,
  diffRefs,
  recordPush,
  NULL_OID,
  type PushEventRow,
  type PushEventStore,
  type RelayScheduler,
} from "./pushEvents.js";
export {
  buildPushArgs,
  buildPushEnv,
  createRelayWorker,
  refspecFor,
  stagingTargets,
  UNCONFIGURED_BACKOFF,
  type RelayOptions,
  type RelayTarget,
  type RelayTargets,
  type RelayWorker,
} from "./relay.js";
export {
  ensureStagingRepo,
  refSnapshot,
  stagingHeadBranch,
  stagingPaths,
  type StagingOptions,
  type StagingPaths,
  type StagingResult,
  type StagingSource,
} from "./staging.js";
export type { GitService, RefChange, RepoRef, SessionLookup, StagingSession } from "./types.js";
