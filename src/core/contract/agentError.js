/**
 * A failure an AI agent can act on without reading English.
 *
 * Two things here are improvements on both siblings rather than translations of
 * them, and both close a hole that is documented and unenforced elsewhere in the
 * family.
 *
 * 1. `retryable` is DERIVED from the category. Both siblings document "always
 *    false for validation, configuration and security" and enforce nothing, so a
 *    single future mistake produces a `blocked` result carrying
 *    `safeToRetry: true` — precisely the contradiction that deriving `status`
 *    from the category exists to prevent. Departing from the derived value
 *    requires `withRetryable(value, reason)`, and the reason is required.
 * 2. Nothing here can carry a stack trace. `detail` is a short, non-sensitive
 *    string, and `sanitiseInternal` below is the only path an unexpected
 *    exception may take to reach an agent.
 */

import { ErrorCategory } from './vocabularies.js';
import { ErrorCode } from './errorCodes.js';
import { deepFreeze } from '../support/freeze.js';

/**
 * Whether the identical call could plausibly succeed later, by category.
 *
 * A transient environment fault, a timeout and a cancellation may be retried.
 * A rejected argument, a missing configuration, a refused path, a missing file
 * and an unimplemented capability will fail identically for ever.
 */
const RETRYABLE_BY_CATEGORY = Object.freeze({
  [ErrorCategory.VALIDATION]: false,
  [ErrorCategory.CONFIGURATION]: false,
  [ErrorCategory.SECURITY]: false,
  [ErrorCategory.NOT_FOUND]: false,
  [ErrorCategory.ENVIRONMENT]: true,
  [ErrorCategory.TIMEOUT]: true,
  [ErrorCategory.CANCELLED]: true,
  [ErrorCategory.NOT_IMPLEMENTED]: false,
  [ErrorCategory.INTERNAL]: false,
});

/** Longest `detail` string that may reach an agent. */
export const MAX_DETAIL_LENGTH = 400;

/**
 * @typedef {object} AgentError
 * @property {string} code        Stable dotted identifier from `ErrorCode`.
 * @property {string} category    Broad class of failure.
 * @property {string} message     One sentence describing what failed.
 * @property {boolean} retryable  Derived from `category` unless explicitly overridden.
 * @property {string} [remediation] Concrete instruction for whoever can fix it.
 * @property {string} [detail]    Non-sensitive specifics. Never a stack, never a secret,
 *                                never an absolute workspace path.
 * @property {string} [retryableReason] Present only when `retryable` departs from the default.
 */

/**
 * Build an error, with `retryable` derived from the category.
 *
 * @param {object} spec
 * @param {string} spec.code
 * @param {string} spec.category
 * @param {string} spec.message
 * @param {string} [spec.remediation]
 * @param {string} [spec.detail]
 * @returns {AgentError}
 */
export function agentError({ code, category, message, remediation, detail }) {
  if (!(category in RETRYABLE_BY_CATEGORY)) {
    throw new TypeError(`'${category}' is not a published error category.`);
  }
  const error = {
    code,
    category,
    message,
    retryable: RETRYABLE_BY_CATEGORY[category],
  };
  if (remediation !== undefined && remediation !== null) error.remediation = remediation;
  if (detail !== undefined && detail !== null) error.detail = truncate(detail, MAX_DETAIL_LENGTH);
  return deepFreeze(error);
}

/**
 * The ONLY supported way to depart from the derived retryability.
 *
 * @param {AgentError} error
 * @param {boolean} retryable
 * @param {string} reason Required. An override without a stated reason is the
 *   free field this design exists to remove.
 * @returns {AgentError}
 */
export function withRetryable(error, retryable, reason) {
  if (typeof retryable !== 'boolean') {
    throw new TypeError('withRetryable requires an explicit boolean.');
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new TypeError(
      'Overriding the derived retryability requires a reason. If there is no reason, the derived value is correct.',
    );
  }
  return deepFreeze({ ...error, retryable, retryableReason: reason });
}

/**
 * The default retryability for a category. Exposed so a test can assert the
 * table rather than trusting it.
 *
 * @param {string} category
 * @returns {boolean}
 */
export function defaultRetryable(category) {
  return RETRYABLE_BY_CATEGORY[category];
}

/**
 * Convert an unexpected exception into a structured error that leaks nothing.
 *
 * This is not tidiness. Probing the MCP SDK with a handler that throws produced
 * this, verbatim, in the client's result:
 *
 *     McpError: MCP error -32603: secret internal detail /home/user/x.mjs line 42
 *
 * A filesystem path, an internal message and an implementation detail, handed to
 * a model that may be reading attacker-influenced content. Everything that could
 * throw goes through here first.
 *
 * The exception's CONSTRUCTOR NAME is kept, because it is often the only useful
 * clue and it carries no data. The message is kept only when it is a Node error
 * code such as `ENOENT`; free-form messages are dropped entirely, because a
 * message is exactly where a path or a credential ends up.
 *
 * @param {unknown} thrown
 * @returns {AgentError}
 */
export function sanitiseInternal(thrown) {
  const name =
    thrown && typeof thrown === 'object' && typeof thrown.constructor?.name === 'string'
      ? thrown.constructor.name
      : typeof thrown;

  // A Node system-error code is a fixed, enumerable token with no payload.
  const systemCode =
    thrown &&
    typeof thrown === 'object' &&
    typeof thrown.code === 'string' &&
    /^[A-Z0-9_]+$/.test(thrown.code)
      ? thrown.code
      : undefined;

  return agentError({
    code: ErrorCode.INTERNAL,
    category: ErrorCategory.INTERNAL,
    message: `The operation failed unexpectedly (${name}).`,
    remediation:
      'This is a defect in GenXEvo. Please report it with the operation name and the detail below.',
    detail: systemCode ? `systemCode=${systemCode}` : undefined,
  });
}

/**
 * @param {string} value
 * @param {number} limit
 * @returns {string}
 */
export function truncate(value, limit) {
  const text = String(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}
