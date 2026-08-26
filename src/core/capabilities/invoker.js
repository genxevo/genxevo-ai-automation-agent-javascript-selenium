/**
 * Running a capability and guaranteeing the shape of what comes back.
 *
 * Every MCP tool goes through this. It makes five invariants true without
 * relying on each capability author remembering them:
 *
 *   * an unhandled exception can never reach the agent as a raw message or path;
 *   * timing and start time are always populated;
 *   * timeout and cancellation are always reported as themselves;
 *   * capabilities that touch shared state are serialised;
 *   * the result satisfies GenXEvo's own published envelope schema before it
 *     leaves the server.
 *
 * THE EXCEPTION FIREWALL IS NOT THEORETICAL. Probing the MCP SDK with a handler
 * that throws produced this, verbatim, in the client's result:
 *
 *     McpError: MCP error -32603: secret internal detail /home/user/x.mjs line 42
 *
 * A filesystem path, an internal message and an implementation detail, handed
 * straight to a model that may be reading attacker-influenced content. Every
 * capability is wrapped here so that cannot happen, and a test asserts it.
 *
 * CANCELLATION IS A COMPOSITION, NOT AN INVENTION — and this is where JavaScript
 * is stronger than both siblings. Python had to build a cooperative
 * `threading.Event` because `asyncio.to_thread` cannot be cancelled; the Java
 * plan has to own cancellation entirely because its SDK does not implement
 * `notifications/cancelled`. The JavaScript SDK hands every low-level tool
 * handler a live `AbortSignal`, so the invoker composes the host's signal with
 * its own deadline in one line and every `node:fs/promises` call downstream
 * accepts it directly.
 */

import { agentError, sanitiseInternal } from '../contract/agentError.js';
import { ErrorCategory } from '../contract/vocabularies.js';
import { ErrorCode } from '../contract/errorCodes.js';
import { failed, stamped } from '../contract/toolResult.js';
import { validateEnvelope, validateKeyOrder } from '../contract/validateEnvelope.js';

export class CapabilityInvoker {
  #clock;
  /** Serialises capabilities that touch shared state. A promise chain is the JavaScript lock. */
  #exclusiveGate = Promise.resolve();

  constructor(clock) {
    this.#clock = clock;
  }

  /**
   * Run a capability body and return a stamped, well-formed, validated result.
   *
   * @param {string} operation Dotted operation identifier.
   * @param {(signal: AbortSignal) => Promise<object>} body
   * @param {object} [options]
   * @param {number} [options.timeoutMs]
   * @param {boolean} [options.exclusive] True when the capability touches state that
   *   must not be entered concurrently — the browser session above all. Selenium's
   *   WebDriver is not thread-safe and an MCP host is free to dispatch tool calls
   *   concurrently, so this is a correctness requirement rather than a precaution.
   * @param {AbortSignal} [options.signal] The host's signal, from the SDK.
   * @returns {Promise<object>}
   */
  async invoke(operation, body, { timeoutMs, exclusive = false, signal } = {}) {
    if (!exclusive) return this.#run(operation, body, timeoutMs, signal);

    const previous = this.#exclusiveGate;
    let release;
    this.#exclusiveGate = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      return await this.#run(operation, body, timeoutMs, signal);
    } finally {
      release();
    }
  }

  async #run(operation, body, timeoutMs, hostSignal) {
    const startedAt = this.#clock.now();
    const startedTicks = performance.now();

    const deadline = typeof timeoutMs === 'number' ? AbortSignal.timeout(timeoutMs) : null;
    const signals = [hostSignal, deadline].filter(Boolean);
    const signal = signals.length === 0 ? new AbortController().signal : AbortSignal.any(signals);

    const stamp = (result) =>
      stamped(result, { startedAt, durationMs: Math.round(performance.now() - startedTicks) });

    let result;
    try {
      result = await body(signal);
    } catch (thrown) {
      if (deadline?.aborted) {
        result = failed(
          operation,
          agentError({
            code: ErrorCode.OPERATION_TIMEOUT,
            category: ErrorCategory.TIMEOUT,
            message: `The operation exceeded its ${Math.round(timeoutMs / 1000)} second budget and was stopped.`,
            remediation:
              'Narrow the scope of the request, or raise the relevant timeout in the GenXEvo configuration. Any partial artefacts are not trustworthy.',
          }),
        );
      } else if (signal.aborted) {
        result = failed(
          operation,
          agentError({
            code: ErrorCode.OPERATION_CANCELLED,
            category: ErrorCategory.CANCELLED,
            message: 'The operation was cancelled before it completed.',
            remediation: 'Re-issue the call if the work is still needed.',
          }),
        );
      } else {
        // The ONLY path an unexpected exception may take to an agent.
        result = failed(operation, sanitiseInternal(thrown));
      }
    }

    const finished = stamp(result);
    return this.#guardContract(operation, finished, startedAt, startedTicks);
  }

  /**
   * GenXEvo validates GenXEvo's own contract, in-process, on every result.
   *
   * This is not belt-and-braces. It was MEASURED that the SDK's low-level path
   * does not enforce a tool's published `outputSchema`: a payload missing a
   * required field, and one carrying a value outside the published enum, were
   * both delivered to the client untouched. There is no net but this one.
   *
   * A contract violation is reported AS a contract violation rather than
   * shipped, because a result an agent cannot parse is indistinguishable from a
   * result that says something false.
   */
  #guardContract(operation, result, startedAt, startedTicks) {
    const schema = validateEnvelope(result);
    const order = validateKeyOrder(result);
    if (schema.valid && order.valid) return result;

    const problems = [...schema.errors, ...order.errors].slice(0, 3).join('; ');
    return stamped(
      failed(
        operation,
        agentError({
          code: ErrorCode.CONTRACT_VIOLATION,
          category: ErrorCategory.INTERNAL,
          message:
            'GenXEvo produced a result that does not satisfy its own published contract, and refused to return it.',
          remediation:
            'This is a defect in GenXEvo. Please report it with the operation name and the detail below.',
          detail: problems,
        }),
      ),
      { startedAt, durationMs: Math.round(performance.now() - startedTicks) },
    );
  }
}
