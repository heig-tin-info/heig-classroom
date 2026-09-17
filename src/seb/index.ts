/** Volet examen : vérification SEB, cookie de session, génération du `.seb`. */
export { configKey, configKeyFromPlistXml, sebJson, EXEMPT_KEY } from "./configKey.js";
export {
  EXAM_COOKIE,
  EXAM_COOKIE_DEFAULT_MAX_AGE_MS,
  examCookieAttributes,
  issueExamCookie,
  verifyExamCookie,
  type ExamClaims,
  type ExamCookieRefusal,
  type ExamCookieVerdict,
} from "./examSession.js";
export {
  isValidSebConfig,
  parsePlist,
  toPlistXml,
  PlistParseError,
  type SebDict,
  type SebValue,
} from "./plist.js";
export {
  checkExamRequest,
  mapLookup,
  outsideSebPage,
  replyOutsideSeb,
  sebRoutes,
  type AssignmentLookup,
  type SebAssignment,
  type SebRoutesOptions,
  type StartContext,
  type StartOutcome,
} from "./routes.js";
export {
  buildSebConfig,
  configKeyOfSebFile,
  newExamKeySalt,
  renderSebFile,
  sebFilePath,
  sebLink,
  sebStartPath,
  SEB_CONTENT_TYPE,
  type GeneratedSebFile,
  type SebConfigInput,
} from "./sebFile.js";
export {
  absoluteRequestUrl,
  createSebVerifier,
  expectedHash,
  hashesEqual,
  CONFIG_KEY_HEADER,
  DEV_HEADER,
  REQUEST_HASH_HEADER,
  SebConfigurationError,
  type AssignmentSebKeys,
  type RequestUrlOptions,
  type SebRefusal,
  type SebRequestFacts,
  type SebVerdict,
  type SebVerifier,
  type SebVerifierConfig,
} from "./verify.js";
