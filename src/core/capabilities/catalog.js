/**
 * The published inventory of GenXEvo capabilities, implemented or not.
 *
 * An agent that can see the whole intended surface — including what is not built
 * yet — plans better than one that discovers absence by calling a tool that is
 * not there. Publishing the planned entries is honest rather than decorative:
 * each carries its state and its delivery phase, and NO PLANNED CAPABILITY IS
 * REGISTERED AS AN MCP TOOL, so an agent can never call a stub. A stub is worse
 * than an honest absence, because it teaches the agent something false.
 *
 * This catalogue is the single source of truth for `docs/mcp-tools.md`, for
 * `genxevo_agent_status`, and for the `ToolAnnotations` published on every
 * registered tool — so `readOnlyHint`, `idempotentHint` and `destructiveHint`
 * reach the client as protocol metadata and a human sees an accurate approval
 * prompt without reading our documentation. The booleans live here as plain
 * values rather than as SDK types, which is what keeps this module free of
 * third-party imports.
 */

import { CapabilityState, SafetyClass } from '../contract/vocabularies.js';
import { deepFreeze } from '../support/freeze.js';

function capability({ name, operation, group, purpose, safety, idempotent, state, phase }) {
  return {
    name,
    operation,
    group,
    purpose,
    safety,
    idempotent,
    state,
    phase,
    /** Becomes the MCP `readOnlyHint`. */
    readOnly: safety === SafetyClass.READ_ONLY,
    /** True when the capability can change something a human would not want changed silently. */
    destructive: safety === SafetyClass.FILE_WRITING || safety === SafetyClass.EXECUTING,
  };
}

export const ALL_CAPABILITIES = deepFreeze([
  // -- agent ---------------------------------------------------------------
  capability({
    name: 'genxevo_agent_status',
    operation: 'agent.status',
    group: 'agent',
    purpose:
      "Report the agent's configuration, approved workspace roots, security policy, host Node runtime and which capabilities this build actually has.",
    safety: SafetyClass.READ_ONLY,
    idempotent: true,
    state: CapabilityState.AVAILABLE,
    phase: '1A',
  }),

  // -- project -------------------------------------------------------------
  capability({
    name: 'genxevo_discover_project',
    operation: 'project.discover',
    group: 'project',
    purpose:
      'Scan the workspace and report the JavaScript automation project that is there: its manifests, package manager, module system, test runner, test roots, browser automation library and toolchain, each with the evidence behind it.',
    safety: SafetyClass.READ_ONLY,
    idempotent: true,
    state: CapabilityState.AVAILABLE,
    phase: '1A',
  }),
  capability({
    name: 'genxevo_read_project_file',
    operation: 'project.read_file',
    group: 'project',
    purpose:
      'Read a source, configuration or test-data file from inside the workspace, redacted and framed as untrusted content.',
    safety: SafetyClass.READ_ONLY,
    idempotent: true,
    state: CapabilityState.PLANNED,
    phase: '1B',
  }),
  capability({
    name: 'genxevo_read_locators',
    operation: 'project.read_locators',
    group: 'project',
    purpose:
      'Extract locator declarations from a page object using a syntax-aware parse, reporting anything it could not classify rather than a count it cannot stand behind.',
    safety: SafetyClass.READ_ONLY,
    idempotent: true,
    state: CapabilityState.PLANNED,
    phase: '1B',
  }),

  // -- environment ---------------------------------------------------------
  capability({
    name: 'genxevo_describe_environment',
    operation: 'environment.describe',
    group: 'environment',
    purpose:
      'Report the Node runtime and installed packages a test run would actually use, and whether they satisfy what the project declares.',
    safety: SafetyClass.READ_ONLY,
    idempotent: true,
    state: CapabilityState.PLANNED,
    phase: '1B',
  }),

  // -- browser -------------------------------------------------------------
  capability({
    name: 'genxevo_browser_session',
    operation: 'browser.session',
    group: 'browser',
    purpose: 'Open, describe or close the browser session, and report exactly what state it is in.',
    safety: SafetyClass.STATE_CHANGING,
    idempotent: false,
    state: CapabilityState.PLANNED,
    phase: '1C',
  }),
  capability({
    name: 'genxevo_browser_navigate',
    operation: 'browser.navigate',
    group: 'browser',
    purpose: 'Navigate the session to a URL and return the resulting page state as evidence.',
    safety: SafetyClass.STATE_CHANGING,
    idempotent: false,
    state: CapabilityState.PLANNED,
    phase: '1C',
  }),
  capability({
    name: 'genxevo_browser_interact',
    operation: 'browser.interact',
    group: 'browser',
    purpose:
      'Perform one user interaction — click, type, select, press, scroll — with an explicit wait policy.',
    safety: SafetyClass.STATE_CHANGING,
    idempotent: false,
    state: CapabilityState.PLANNED,
    phase: '1C',
  }),
  capability({
    name: 'genxevo_inspect_element',
    operation: 'browser.inspect_element',
    group: 'browser',
    purpose:
      'Capture ground truth for an element: state, attributes, ancestors, siblings and a screenshot — the neighbourhood, not just the node.',
    safety: SafetyClass.READ_ONLY,
    idempotent: true,
    state: CapabilityState.PLANNED,
    phase: '1C',
  }),
  capability({
    name: 'genxevo_evaluate_locators',
    operation: 'browser.evaluate_locators',
    group: 'browser',
    purpose:
      'Evaluate a batch of locators of any strategy against the live page, including inside iframes, under one explicit wait policy.',
    safety: SafetyClass.READ_ONLY,
    idempotent: true,
    state: CapabilityState.PLANNED,
    phase: '1C',
  }),
  capability({
    name: 'genxevo_capture_evidence',
    operation: 'evidence.capture',
    group: 'evidence',
    purpose:
      'Capture page state, screenshot, DOM and console output as one correlated evidence bundle.',
    safety: SafetyClass.READ_ONLY,
    idempotent: true,
    state: CapabilityState.PLANNED,
    phase: '1C',
  }),

  // -- execution -----------------------------------------------------------
  capability({
    name: 'genxevo_run_tests',
    operation: 'execution.run',
    group: 'execution',
    purpose:
      "Execute a validated, narrow test selection with the project's own runner in an isolated run directory, and return a correlated run identifier.",
    safety: SafetyClass.EXECUTING,
    idempotent: false,
    state: CapabilityState.PLANNED,
    phase: '1D',
  }),
  capability({
    name: 'genxevo_get_run',
    operation: 'execution.get_run',
    group: 'execution',
    purpose:
      'Return a run record and parsed results by identifier, never by the newest file on disk.',
    safety: SafetyClass.READ_ONLY,
    idempotent: true,
    state: CapabilityState.PLANNED,
    phase: '1D',
  }),
  capability({
    name: 'genxevo_compare_runs',
    operation: 'execution.compare',
    group: 'execution',
    purpose:
      'Compare two runs and classify each test as fixed, still failing, newly failing or unchanged — never by comparing pass counts.',
    safety: SafetyClass.READ_ONLY,
    idempotent: true,
    state: CapabilityState.PLANNED,
    phase: '1D',
  }),

  // -- repair --------------------------------------------------------------
  capability({
    name: 'genxevo_open_repair',
    operation: 'repair.open',
    group: 'repair',
    purpose:
      'Open a bounded repair cycle for a specific failure, recording the evidence that justified it and the ceiling on attempts.',
    safety: SafetyClass.FILE_WRITING,
    idempotent: false,
    state: CapabilityState.PLANNED,
    phase: '1E',
  }),
  capability({
    name: 'genxevo_verify_repair',
    operation: 'repair.verify',
    group: 'repair',
    purpose:
      'Decide whether a repair is genuinely verified, from a fresh run correlated to the original failure.',
    safety: SafetyClass.READ_ONLY,
    idempotent: true,
    state: CapabilityState.PLANNED,
    phase: '1E',
  }),
  capability({
    name: 'genxevo_write_report',
    operation: 'repair.report',
    group: 'repair',
    purpose:
      'Write a diagnosis-and-repair report to a configured location outside the build output.',
    safety: SafetyClass.FILE_WRITING,
    idempotent: false,
    state: CapabilityState.PLANNED,
    phase: '1E',
  }),
]);

/** Capabilities this build actually publishes as MCP tools. */
export const AVAILABLE_CAPABILITIES = deepFreeze(
  ALL_CAPABILITIES.filter((c) => c.state === CapabilityState.AVAILABLE),
);

/** The phase this build implements. Asserted against `AVAILABLE_CAPABILITIES` by a test. */
export const IMPLEMENTED_PHASE = '1A';

export function capabilityByName(name) {
  return ALL_CAPABILITIES.find((c) => c.name === name) ?? null;
}
