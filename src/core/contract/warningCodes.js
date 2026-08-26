/**
 * The published WARNING-code vocabulary.
 *
 * This module exists because both sibling products have a defect here and it is
 * the same defect: warning codes are bare string literals scattered across five
 * files, one of them duplicated, while the documentation tells the agent to
 * "read `warnings` whenever status is `partialSuccess`".
 *
 * An agent cannot branch on a vocabulary that was never published. Warning codes
 * therefore get exactly what error codes get: constants, a table in
 * `docs/mcp-tools.md`, and a uniqueness test.
 */

export const WarningCode = Object.freeze({
  /** An operation was intentionally not performed; carried by every `skipped` result. */
  OPERATION_SKIPPED: 'operation.skipped',

  /** A non-fatal configuration finding an operator should see on every status call. */
  CONFIGURATION_ADVISORY: 'configuration.advisory',

  /** The scan hit its depth or entry limit. "Not found" may mean "not looked at". */
  DISCOVERY_SCAN_LIMIT_REACHED: 'discovery.scan_limit_reached',
  /** A workspace root could not be fully scanned. */
  DISCOVERY_ROOT_UNREADABLE: 'discovery.root_unreadable',
  /** A directory was skipped because it could not be read. */
  DISCOVERY_DIRECTORY_UNREADABLE: 'discovery.directory_unreadable',
  /** A manifest was found but could not be parsed; do not read this as "no dependencies". */
  DISCOVERY_MANIFEST_UNREADABLE: 'discovery.manifest_unreadable',
  /** A file was found and deliberately not read, because it is on the security deny-list. */
  DISCOVERY_FILE_DENIED: 'discovery.file_denied',
  /** The project declares one package manager and a different one's lockfile is present. */
  DISCOVERY_TOOLCHAIN_MISMATCH: 'discovery.toolchain_mismatch',
  /** The project's automation library is not the one this build provides capabilities for. */
  DISCOVERY_FRAMEWORK_MISMATCH: 'discovery.framework_mismatch',

  /** A selection was accepted but is broad enough to run far more than one test. */
  SELECTION_VERY_BROAD: 'selection.very_broad',
  /** A selection names a whole file or directory rather than a single test. */
  SELECTION_WHOLE_FILE: 'selection.whole_file',

  /** An evidence payload was written to an artefact file rather than inlined. */
  EVIDENCE_SPILLED_TO_ARTIFACT: 'evidence.spilled_to_artifact',
});

export const WARNING_CODE_VALUES = Object.freeze(Object.values(WarningCode));
