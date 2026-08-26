/**
 * Everything a capability needs, assembled once at start-up.
 *
 * The runtime is deliberately constructible in an UNCONFIGURED state. If the
 * operator has not named a workspace, GenXEvo still starts, still registers its
 * tools, and every capability returns the same actionable `configurationError`
 * carrying the remedy.
 *
 * Exiting instead would be worse in a way that is easy to miss: from the
 * client's side, a server that exits is a server that VANISHED, and the agent
 * has nothing to relay to the human. A server that answers "I am not configured,
 * here is exactly what to do" turns a dead end into an actionable message.
 */

import path from 'node:path';

import { ErrorCategory } from '../contract/vocabularies.js';
import { ErrorCode } from '../contract/errorCodes.js';
import { agentError } from '../contract/agentError.js';
import { failed, nextAction } from '../contract/toolResult.js';
import { DEFAULT_CONFIGURATION } from '../config/configuration.js';
import { loadConfiguration } from '../config/load.js';
import { AGENT_DATA_DIRECTORY, PathBoundary, PathBoundaryError } from '../security/pathBoundary.js';
import { NullSecretRedactor, SecretRedactor } from '../security/redaction.js';
import { ProjectDiscoveryService } from '../discovery/service.js';
import { FileRunRegistry } from '../runs/runModel.js';
import { CapabilityInvoker } from './invoker.js';
import { SYSTEM_CLOCK } from '../support/clock.js';

export class AgentRuntime {
  constructor(parts) {
    Object.assign(this, parts);
    Object.freeze(this);
  }

  /** True when capabilities can do real work. */
  get isConfigured() {
    return this.configurationError === null && this.boundary !== null;
  }

  /**
   * The standard unconfigured result.
   *
   * Every capability answers identically when unconfigured, so an agent learns
   * the remedy once rather than once per tool.
   */
  notConfigured(operation) {
    return failed(
      operation,
      this.configurationError ??
        agentError({
          code: ErrorCode.WORKSPACE_NOT_CONFIGURED,
          category: ErrorCategory.CONFIGURATION,
          message: 'The agent is not configured.',
          remediation:
            'Start the GenXEvo agent with --workspace "<path to your automation project>".',
        }),
      {
        nextActions: [
          nextAction(
            'genxevo_agent_status',
            "Read the agent's current configuration state and the exact remedy before retrying anything else.",
          ),
        ],
      },
    );
  }
}

/**
 * Build a runtime from configuration sources.
 *
 * Never throws for a configuration problem: an unusable configuration produces
 * an unconfigured runtime that can still answer every tool call.
 */
export function createRuntime(sources, { clock = SYSTEM_CLOCK } = {}) {
  const invoker = new CapabilityInvoker(clock);
  const load = loadConfiguration(sources);

  if (!load.loaded) {
    return new AgentRuntime({
      configuration: DEFAULT_CONFIGURATION,
      invoker,
      // An unconfigured agent STILL REDACTS. Nothing about being unconfigured
      // makes a leak acceptable.
      redactor: new SecretRedactor(),
      configurationError: load.error ?? null,
      issues: load.issues,
      configurationSource: load.sourcePath,
      boundary: null,
      discovery: null,
      runs: null,
      clock,
    });
  }

  const configuration = load.configuration;
  const redactor = configuration.security.redactSecrets
    ? new SecretRedactor(configuration.security.additionalSecretKeyFragments)
    : new NullSecretRedactor();

  let boundary;
  try {
    boundary = new PathBoundary(configuration.workspace.roots, {
      deniedGlobs: configuration.security.deniedFileGlobs,
    });
  } catch (thrown) {
    return new AgentRuntime({
      configuration,
      invoker,
      redactor,
      configurationError: agentError({
        code: ErrorCode.CONFIG_INVALID,
        category: ErrorCategory.CONFIGURATION,
        message: 'The configured workspace roots could not be used.',
        remediation: "Check that every path in 'workspace.roots' is an existing directory.",
        detail: thrown instanceof PathBoundaryError ? thrown.message : undefined,
      }),
      issues: load.issues,
      configurationSource: load.sourcePath,
      boundary: null,
      discovery: null,
      runs: null,
      clock,
    });
  }

  return new AgentRuntime({
    configuration,
    invoker,
    redactor,
    configurationError: null,
    issues: load.issues,
    configurationSource: load.sourcePath,
    boundary,
    discovery: new ProjectDiscoveryService({ configuration, boundary, redactor }),
    runs: new FileRunRegistry(path.join(boundary.roots[0], AGENT_DATA_DIRECTORY, 'runs')),
    clock,
  });
}
