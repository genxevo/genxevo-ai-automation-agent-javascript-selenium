/**
 * The result contract: how a capability tells an AI agent what happened.
 *
 * The single most damaging defect in the implementation this family learned
 * from was that failure and success were indistinguishable without reading
 * English prose. `"NOT FOUND: ..."`, `"TIMED OUT after 15 minutes"` and a
 * `Failed: 0` that also meant "every test was skipped" were all returned as
 * successful tool results. An agent that cannot tell success from failure will
 * confidently report a repair it never verified, which is worse than not
 * helping at all.
 *
 * Everything here exists to make that impossible:
 *
 *  * `ResultStatus` has one value per decision an agent has to make.
 *  * Results are built ONLY through the factories below, which enforce the
 *    invariants rather than trusting each author to remember them.
 *  * `status` is DERIVED from the error's category, so the two cannot disagree.
 *  * A partial success cannot be constructed without a warning explaining it.
 *  * `safeToRetry` mirrors the error's retryability and is never a default.
 *
 * Two JavaScript-native properties do work that the siblings need machinery for.
 * `JSON.stringify` emits string keys in insertion order per ECMA-262, so
 * building the object in `ENVELOPE_KEY_ORDER` *is* the emission contract — no
 * `[JsonPropertyOrder]` equivalent is needed. And an optional field that is
 * absent is simply never assigned, so omission is the default and emitting
 * `null` would take extra work.
 */

import {
  CONTRACT_VERSION,
  ErrorCategory,
  ResultStatus,
  RESULT_STATUS_VALUES,
} from './vocabularies.js';
import { ErrorCode } from './errorCodes.js';
import { WarningCode } from './warningCodes.js';
import { agentError } from './agentError.js';
import { isoUtc } from './evidence.js';
import { deepFreeze } from '../support/freeze.js';

/** Category -> status. `failed()` has no status parameter, so they cannot disagree. */
const STATUS_FOR_CATEGORY = Object.freeze({
  [ErrorCategory.VALIDATION]: ResultStatus.VALIDATION_ERROR,
  [ErrorCategory.CONFIGURATION]: ResultStatus.CONFIGURATION_ERROR,
  [ErrorCategory.SECURITY]: ResultStatus.BLOCKED,
  [ErrorCategory.TIMEOUT]: ResultStatus.TIMEOUT,
  [ErrorCategory.CANCELLED]: ResultStatus.CANCELLED,
});

/**
 * A non-fatal problem. Its presence is the reason a result may be
 * `partialSuccess`, and `partial()` refuses to build one without it.
 *
 * @param {string} code   From `WarningCode`. A published vocabulary, not a literal.
 * @param {string} message
 * @param {string} [detail]
 * @returns {{code: string, message: string, detail?: string}}
 */
export function resultWarning(code, message, detail) {
  const warning = { code, message };
  if (detail !== undefined && detail !== null) warning.detail = detail;
  return deepFreeze(warning);
}

/**
 * A suggested follow-up capability call. Advisory only — the server never
 * enforces sequencing. This exists so a failing result can tell the agent how to
 * make progress instead of leaving it to guess.
 *
 * @param {string} tool
 * @param {string} reason
 * @param {Record<string,string>} [args]
 */
export function nextAction(tool, reason, args) {
  const action = { tool, reason };
  if (args !== undefined && args !== null) action.arguments = { ...args };
  return deepFreeze(action);
}

/**
 * Assemble the envelope in canonical key order.
 *
 * @param {object} parts
 * @returns {Readonly<object>}
 */
function envelope({
  status,
  operation,
  summary,
  runId,
  data,
  warnings,
  error,
  evidence,
  nextActions,
  durationMs,
  startedAt,
  safeToRetry,
}) {
  const result = {};
  result.contractVersion = CONTRACT_VERSION;
  result.status = status;
  result.operation = operation;
  result.summary = summary;
  if (runId !== undefined && runId !== null) result.runId = runId;
  if (data !== undefined && data !== null) result.data = data;
  result.warnings = warnings ?? [];
  if (error !== undefined && error !== null) result.error = error;
  result.evidence = evidence ?? [];
  result.nextActions = nextActions ?? [];
  result.durationMs = durationMs ?? 0;
  result.startedAt = startedAt ?? isoUtc(new Date(0));
  result.safeToRetry = safeToRetry;
  return deepFreeze(result);
}

/** The operation fully succeeded. */
export function success(operation, summary, { data, evidence, nextActions, warnings, runId } = {}) {
  return envelope({
    status: ResultStatus.SUCCESS,
    operation,
    summary,
    runId,
    data,
    warnings,
    evidence,
    nextActions,
    safeToRetry: true,
  });
}

/**
 * The operation produced usable data but something did not succeed.
 *
 * @throws {TypeError} when no warning is supplied. A partial success with
 *   nothing to explain it is exactly the ambiguity this contract exists to
 *   prevent, so it is refused at construction rather than shipped.
 */
export function partial(operation, summary, warnings, { data, evidence, nextActions, runId } = {}) {
  if (!Array.isArray(warnings) || warnings.length === 0) {
    throw new TypeError('A partial success must explain what was incomplete.');
  }
  return envelope({
    status: ResultStatus.PARTIAL_SUCCESS,
    operation,
    summary,
    runId,
    data,
    warnings,
    evidence,
    nextActions,
    safeToRetry: true,
  });
}

/**
 * The operation was intentionally not performed. Not an error.
 *
 * Symmetric with every other factory, deliberately. Both siblings' `skipped()`
 * can carry neither data, nor evidence, nor next actions, while every other
 * factory can — and `skipped` counts as success. An operation that was skipped
 * must be able to say why AND what to do next.
 */
export function skipped(operation, summary, reason, { data, evidence, nextActions, runId } = {}) {
  return envelope({
    status: ResultStatus.SKIPPED,
    operation,
    summary,
    runId,
    data,
    warnings: [resultWarning(WarningCode.OPERATION_SKIPPED, reason)],
    evidence,
    nextActions,
    safeToRetry: true,
  });
}

/**
 * A failure.
 *
 * The status is derived from the error's category and `safeToRetry` mirrors the
 * error's retryability, so neither can disagree with the error it describes.
 * There is deliberately no `status` parameter.
 */
export function failed(operation, error, { summary, data, evidence, nextActions, runId } = {}) {
  return envelope({
    status: STATUS_FOR_CATEGORY[error.category] ?? ResultStatus.FAILURE,
    operation,
    summary: summary ?? error.message,
    runId,
    data,
    error,
    evidence,
    nextActions,
    safeToRetry: error.retryable,
  });
}

/** Convenience for the most common validation failure. */
export function invalidArgument(operation, argument, problem, remediation) {
  return failed(
    operation,
    agentError({
      code: ErrorCode.ARGUMENT_INVALID,
      category: ErrorCategory.VALIDATION,
      message: `Argument '${argument}' was rejected: ${problem}`,
      remediation: remediation ?? `Call '${operation}' again with a corrected '${argument}'.`,
    }),
  );
}

/** Convenience for a capability that exists in the contract but not in this build. */
export function notImplemented(operation, plannedPhase) {
  return failed(
    operation,
    agentError({
      code: ErrorCode.NOT_IMPLEMENTED,
      category: ErrorCategory.NOT_IMPLEMENTED,
      message: `Capability '${operation}' is not implemented in this build.`,
      remediation: `This capability is scheduled for phase ${plannedPhase}. Do not retry; choose a different approach.`,
    }),
  );
}

/**
 * Return a copy carrying the invoker's timing.
 *
 * Results are frozen, so this replaces rather than mutates — and it rebuilds in
 * canonical key order rather than spreading, because a spread would put the
 * replaced keys last and silently break the emission contract.
 */
export function stamped(result, { startedAt, durationMs }) {
  return envelope({
    status: result.status,
    operation: result.operation,
    summary: result.summary,
    runId: result.runId,
    data: result.data,
    warnings: result.warnings,
    error: result.error,
    evidence: result.evidence,
    nextActions: result.nextActions,
    durationMs,
    startedAt: startedAt instanceof Date ? isoUtc(startedAt) : startedAt,
    safeToRetry: result.safeToRetry,
  });
}

/**
 * Convenience for callers inside the server. An agent branches on `status`.
 *
 * @param {{status: string}} result
 * @returns {boolean}
 */
export function isSuccess(result) {
  return result.status === ResultStatus.SUCCESS || result.status === ResultStatus.SKIPPED;
}

/** Exposed so a test can assert the mapping table rather than trusting it. */
export function statusForCategory(category) {
  return STATUS_FOR_CATEGORY[category] ?? ResultStatus.FAILURE;
}

export { RESULT_STATUS_VALUES };
