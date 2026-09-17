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
// `db.ts` a disparu en V1 : la base est celle du portail (`db/client.ts`).
export {
  createForgejoForge,
  createGithubForge,
  type Forge,
  type ForgejoOptions,
  type GithubOptions,
} from "./forge.js";
export { git, gitBare, redactSecrets, GitError } from "./gitRunner.js";
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
  type RelayOptions,
  type RelayTarget,
  type RelayTargets,
  type RelayWorker,
} from "./relay.js";
export {
  ensureStagingRepo,
  refSnapshot,
  stagingPaths,
  type StagingOptions,
  type StagingPaths,
  type StagingSource,
} from "./staging.js";
export type { GitService, RefChange, RepoRef, SessionLookup, StagingSession } from "./types.js";
