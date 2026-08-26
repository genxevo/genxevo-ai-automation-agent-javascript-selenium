/**
 * The published error-code vocabulary.
 *
 * These strings are part of the public contract. An agent — or a team's own
 * automation around this server — may branch on them, so a code's meaning is
 * fixed once released. Add new codes freely; never repurpose an existing one.
 *
 * Codes are identical to the C# and Python siblings' wherever the concept is the
 * same. JavaScript-only additions are grouped at the end.
 */

export const ErrorCode = Object.freeze({
  // Configuration
  WORKSPACE_NOT_CONFIGURED: 'config.workspace_not_configured',
  CONFIG_NOT_FOUND: 'config.file_not_found',
  CONFIG_INVALID: 'config.invalid',
  CAPABILITY_DISABLED: 'config.capability_disabled',

  // Security / boundary
  PATH_OUTSIDE_WORKSPACE: 'security.path_outside_workspace',
  PATH_DENIED: 'security.path_denied',
  PATH_MALFORMED: 'security.path_malformed',
  SELECTION_REJECTED: 'security.selection_rejected',

  // Validation
  ARGUMENT_MISSING: 'validation.argument_missing',
  ARGUMENT_INVALID: 'validation.argument_invalid',

  // Not found
  FILE_NOT_FOUND: 'notfound.file',
  DIRECTORY_NOT_FOUND: 'notfound.directory',
  RUN_NOT_FOUND: 'notfound.run',
  PROJECT_NOT_FOUND: 'notfound.project',

  // Environment
  FILE_READ_FAILED: 'environment.file_read_failed',
  FILE_WRITE_FAILED: 'environment.file_write_failed',
  SCAN_FAILED: 'environment.scan_failed',

  // Lifecycle
  OPERATION_TIMEOUT: 'lifecycle.timeout',
  OPERATION_CANCELLED: 'lifecycle.cancelled',

  // Build state
  NOT_IMPLEMENTED: 'capability.not_implemented',

  // Catch-all
  INTERNAL: 'internal.unexpected',

  // -- JavaScript-specific ------------------------------------------------
  /** A package.json, lockfile or runner configuration was found but could not be parsed. */
  MANIFEST_UNREADABLE: 'environment.manifest_unreadable',
  /** The result GenXEvo was about to return did not satisfy its own published envelope schema. */
  CONTRACT_VIOLATION: 'internal.contract_violation',
});

export const ERROR_CODE_VALUES = Object.freeze(Object.values(ErrorCode));
