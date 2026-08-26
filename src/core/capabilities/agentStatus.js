/**
 * Reporting what the agent is, what it may touch, and what it can currently do.
 *
 * This is the capability an agent should call first, and again whenever anything
 * is confusing. Its predecessor in the implementation this family learned from
 * was a liveness ping that proved only that a process was running - it could not
 * say whether the workspace was readable, whether execution was permitted, or
 * which capabilities existed. Every question an agent would otherwise discover
 * by trial and error is answered here, in one call.
 */

import path from 'node:path';

import { WarningCode } from '../contract/warningCodes.js';
import { nextAction, resultWarning, success } from '../contract/toolResult.js';
import { ALL_CAPABILITIES, AVAILABLE_CAPABILITIES } from './catalog.js';

export const OPERATION = 'agent.status';

export class AgentStatusCapability {
  #runtime;
  #version;

  constructor(runtime, productVersion) {
    this.#runtime = runtime;
    this.#version = productVersion;
  }

  /**
   * Build the status result.
   *
   * The signal is accepted for signature uniformity with every other capability
   * and is not used: this call reads only in-memory state and cannot run long.
   */
  async execute(_signal) {
    const runtime = this.#runtime;
    const configuration = runtime.configuration;
    const configured = runtime.isConfigured;

    const data = {
      product: 'GenXEvo AI Automation Agent - JavaScript Selenium',
      version: this.#version,
      configured,
      configurationSource:
        runtime.configurationSource === null
          ? 'defaults (no configuration file was read)'
          : path.basename(runtime.configurationSource),

      // The Node hosting the server, which is frequently NOT the one the
      // automation project's tests run on. Saying so here saves an agent from
      // diagnosing a module-resolution error that was never a test failure.
      host: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        note: 'This is the Node runtime executing GenXEvo itself. The automation project may declare, pin or require a different one; genxevo_discover_project reports that.',
      },

      // Root NAMES only. The agent needs to know how many roots it has and what
      // they are called; it does not need the operator's absolute directory
      // layout, and neither does anything reading the transcript.
      workspace: {
        rootCount: runtime.boundary?.roots.length ?? 0,
        rootNames: (runtime.boundary?.roots ?? []).map((root) => path.basename(root)),
        ignoredDirectories: configuration.workspace.ignoredDirectories,
        maxScanDepth: configuration.workspace.maxScanDepth,
        maxScanEntries: configuration.workspace.maxScanEntries,
      },

      security: {
        secretRedaction: configuration.security.redactSecrets ? 'enabled' : 'DISABLED',
        untrustedContentFraming: configuration.security.frameUntrustedContent
          ? 'enabled'
          : 'DISABLED',
        deniedFileGlobCount: configuration.security.deniedFileGlobs.length,
        pathContainment:
          'enforced by the server; paths outside the workspace roots are refused, and symlinks and junctions are resolved before containment is tested',
        projectCodeExecution:
          'GenXEvo never imports, evaluates, installs or runs anything in the automation project. Runner configuration files are executable JavaScript and are read as text only.',
        resultValidation:
          "every result is validated against GenXEvo's own published envelope schema before it is returned; the MCP SDK does not enforce outputSchema on this path",
      },

      execution: {
        enabled: configuration.execution.enabled,
        runner: configuration.execution.runner,
        selectionRequired: configuration.execution.requireSelection,
        timeoutSeconds: configuration.execution.defaultTimeoutSeconds,
        projectScriptsAllowed: configuration.execution.useProjectScripts,
        note: 'Execution capabilities arrive in phase 1D. This section reports the policy that will govern them; no test process is started by this build.',
      },

      browser: {
        sessionOpen: false,
        kind: configuration.browser.kind,
        headless: configuration.browser.headless,
        note: 'Browser capabilities arrive in phase 1C. No browser process is started by this build, and selenium-webdriver is not a dependency of it.',
      },

      repair: {
        maxCyclesPerFailure: configuration.repair.maxCyclesPerFailure,
        requireVerificationRun: configuration.repair.requireVerificationRun,
        note: 'Repair capabilities arrive in phase 1E.',
      },

      capabilities: ALL_CAPABILITIES.map((c) => ({
        name: c.name,
        operation: c.operation,
        group: c.group,
        state: c.state,
        safety: c.safety,
        idempotent: c.idempotent,
        phase: c.phase,
        purpose: c.purpose,
      })),
      capabilityCounts: {
        available: AVAILABLE_CAPABILITIES.length,
        total: ALL_CAPABILITIES.length,
      },

      configurationIssues: runtime.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
        severity: issue.fatal ? 'fatal' : 'warning',
      })),
    };

    const warnings = runtime.issues
      .filter((issue) => !issue.fatal)
      .map((issue) => resultWarning(WarningCode.CONFIGURATION_ADVISORY, issue.message, issue.path));

    if (!configured) {
      // Deliberately a SUCCESS, not a failure. The agent asked what state the
      // agent is in and got a complete, accurate answer. "You are not
      // configured" IS that answer, not a failure to answer.
      return success(
        OPERATION,
        'GenXEvo is running but is NOT configured: no workspace root has been approved, so no capability can read anything yet.',
        {
          data,
          warnings,
          nextActions: [
            nextAction(
              '(operator action)',
              runtime.configurationError?.remediation ??
                'Restart the agent with --workspace pointing at the automation project.',
            ),
          ],
        },
      );
    }

    const summary =
      `GenXEvo ${this.#version} is configured over ${runtime.boundary.roots.length} workspace root(s). ` +
      `${AVAILABLE_CAPABILITIES.length} of ${ALL_CAPABILITIES.length} capabilities are available in this build. ` +
      `Secret redaction ${configuration.security.redactSecrets ? 'is on' : 'is OFF'}.`;

    return success(OPERATION, summary, {
      data,
      warnings,
      nextActions: [
        nextAction(
          'genxevo_discover_project',
          'Establish what automation project is in the workspace, which runner it uses and whether it is a Selenium project at all, before reasoning about any test or locator.',
        ),
      ],
    });
  }
}
