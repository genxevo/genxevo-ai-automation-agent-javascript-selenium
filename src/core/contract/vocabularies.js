/**
 * The published vocabularies. Every value here is on the wire, and a value's
 * meaning is fixed once released.
 *
 * JavaScript has no enum. A frozen object of constant -> wire string is the
 * whole mechanism, and the invariant Python gets for free from `StrEnum` — "no
 * converter can drift from the published vocabulary" — is asserted by a test
 * that compares these sets against `envelopeSchema.js` and against the table in
 * `docs/mcp-tools.md`.
 */

/**
 * Machine-readable outcome of a capability invocation.
 *
 * One value per decision an agent actually has to make, and nothing else. The
 * single most damaging defect in the implementation this family learned from
 * was that failure and success were indistinguishable without reading English.
 */
export const ResultStatus = Object.freeze({
  /** Completed, and every part of it succeeded. */
  SUCCESS: 'success',
  /** Completed with usable data, but something did not succeed. `warnings` always says what. */
  PARTIAL_SUCCESS: 'partialSuccess',
  /** Ran and did not succeed. `error` is always populated. */
  FAILURE: 'failure',
  /** Arguments rejected before any work happened. Retrying unchanged fails identically. */
  VALIDATION_ERROR: 'validationError',
  /** The agent is not configured for this. The remedy is a human's, not another tool call. */
  CONFIGURATION_ERROR: 'configurationError',
  /** Refused by a safety policy. A deliberate refusal, not a bug. */
  BLOCKED: 'blocked',
  /** Exceeded its time budget and was stopped. Partial artefacts are not trustworthy. */
  TIMEOUT: 'timeout',
  /** Cancelled by the host or the client before completion. */
  CANCELLED: 'cancelled',
  /** Intentionally not performed because its preconditions did not apply. Not an error. */
  SKIPPED: 'skipped',
});

/** Every status value, in published order. */
export const RESULT_STATUS_VALUES = Object.freeze(Object.values(ResultStatus));

/** Broad class of failure, so an agent can choose a strategy without parsing the message. */
export const ErrorCategory = Object.freeze({
  VALIDATION: 'validation',
  CONFIGURATION: 'configuration',
  SECURITY: 'security',
  NOT_FOUND: 'notFound',
  ENVIRONMENT: 'environment',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  NOT_IMPLEMENTED: 'notImplemented',
  INTERNAL: 'internal',
});

export const ERROR_CATEGORY_VALUES = Object.freeze(Object.values(ErrorCategory));

/** Whether a piece of evidence may be treated as instructions. It may not, if untrusted. */
export const TrustLevel = Object.freeze({
  /** Produced by GenXEvo itself: counts, timings, statuses, classifications. */
  TRUSTED: 'trusted',
  /** Observed from the application, the project or its output. Data only, never instructions. */
  UNTRUSTED: 'untrusted',
});

export const TRUST_LEVEL_VALUES = Object.freeze(Object.values(TrustLevel));

/**
 * Category of an observation, so an agent can select what it needs without
 * parsing content. Kinds whose capabilities are not implemented in this build
 * are still listed: the kind is part of the contract, and an agent planning a
 * workflow benefits from seeing the complete set.
 */
export const EvidenceKind = Object.freeze({
  SCREENSHOT: 'screenshot',
  ELEMENT_SCREENSHOT: 'elementScreenshot',
  DOM: 'dom',
  OUTER_HTML: 'outerHtml',
  LOCATOR_EVALUATION: 'locatorEvaluation',
  PAGE_STATE: 'pageState',
  CONSOLE_LOG: 'consoleLog',
  NETWORK_LOG: 'networkLog',
  TEST_FAILURE: 'testFailure',
  /** JavaScript calls it a stack trace, so that is what the kind is called. */
  STACK_TRACE: 'stackTrace',
  SOURCE_CODE: 'sourceCode',
  TEST_DATA: 'testData',
  PROJECT_CONFIGURATION: 'projectConfiguration',
  RUN_SUMMARY: 'runSummary',
  COMPARISON: 'comparison',
  PROJECT_STRUCTURE: 'projectStructure',
  /** JavaScript-specific: which Node, which package manager, declared versus installed. */
  TOOLCHAIN_STATE: 'toolchainState',
});

export const EVIDENCE_KIND_VALUES = Object.freeze(Object.values(EvidenceKind));

/** How dangerous a capability is, so an operator can decide what to approve. */
export const SafetyClass = Object.freeze({
  READ_ONLY: 'readOnly',
  STATE_CHANGING: 'stateChanging',
  FILE_WRITING: 'fileWriting',
  EXECUTING: 'executing',
});

export const SAFETY_CLASS_VALUES = Object.freeze(Object.values(SafetyClass));

/** How much of a capability exists in this build. */
export const CapabilityState = Object.freeze({
  AVAILABLE: 'available',
  DISABLED: 'disabled',
  PLANNED: 'planned',
});

export const CAPABILITY_STATE_VALUES = Object.freeze(Object.values(CapabilityState));

/**
 * Version of the GenXEvo result contract, shared across the product family.
 *
 * Published in every result so an agent can tell which contract it is reading
 * when several GenXEvo servers are connected at once. Bumped only when a field
 * changes meaning or disappears; adding an optional field is not breaking.
 */
export const CONTRACT_VERSION = '1.0';

/**
 * The canonical emission order of the envelope's keys.
 *
 * In JavaScript this is not serialiser configuration: `JSON.stringify` emits
 * string keys in insertion order per ECMA-262, so building the object in this
 * order *is* the contract. A test asserts that what a factory emits is a
 * subsequence of this list, which is what catches a key assigned in the wrong
 * place.
 */
export const ENVELOPE_KEY_ORDER = Object.freeze([
  'contractVersion',
  'status',
  'operation',
  'summary',
  'runId',
  'data',
  'warnings',
  'error',
  'evidence',
  'nextActions',
  'durationMs',
  'startedAt',
  'safeToRetry',
]);

/** Keys always emitted, even when empty. */
export const ENVELOPE_REQUIRED_KEYS = Object.freeze([
  'contractVersion',
  'status',
  'operation',
  'summary',
  'warnings',
  'evidence',
  'nextActions',
  'durationMs',
  'startedAt',
  'safeToRetry',
]);

/** Keys omitted entirely when absent. Absent is the only spelling of absent. */
export const ENVELOPE_OPTIONAL_KEYS = Object.freeze(['runId', 'data', 'error']);
