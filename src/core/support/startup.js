/**
 * Command-line inputs accepted by the GenXEvo MCP server.
 *
 * `--workspace` is the single input that decides what the agent is allowed to
 * read, so parsing it is a security-relevant operation and is written as a PURE
 * FUNCTION: given arguments, return options and errors; touch nothing, exit
 * nothing, print nothing.
 *
 * Hand-rolled on purpose. Four options do not justify a parsing dependency in a
 * security-sensitive process, and a pure function is trivially testable — which
 * matters more here than anywhere else in the product.
 *
 * NOTHING IS EVER WRITTEN TO STDOUT from this module or its caller. stdout
 * belongs to the MCP JSON-RPC transport. Help and version text go to stderr, and
 * a CI job asserts it.
 */

export const PROGRAM_NAME = 'genxevo-selenium-agent';

/**
 * @typedef {object} StartupOptions
 * @property {string | null} workspace
 * @property {string | null} configPath
 * @property {boolean} showVersion
 * @property {boolean} showHelp
 * @property {ReadonlyArray<string>} errors
 */

/**
 * Parse the command line. Never throws, never exits.
 *
 * @param {ReadonlyArray<string>} argv
 * @returns {StartupOptions}
 */
export function parseStartupOptions(argv) {
  let workspace = null;
  let configPath = null;
  let showVersion = false;
  let showHelp = false;
  const errors = [];

  const args = [...(argv ?? [])];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '--workspace' || argument === '-w') {
      const value = takeValue(args, index);
      if (value === null) errors.push('--workspace requires a directory path.');
      else {
        workspace = value;
        index += 1;
      }
    } else if (argument === '--config' || argument === '-c') {
      const value = takeValue(args, index);
      if (value === null) errors.push('--config requires a file path.');
      else {
        configPath = value;
        index += 1;
      }
    } else if (argument === '--version' || argument === '-v') {
      showVersion = true;
    } else if (argument === '--help' || argument === '-h') {
      showHelp = true;
    } else if (argument.startsWith('--workspace=')) {
      workspace = argument.slice('--workspace='.length);
    } else if (argument.startsWith('--config=')) {
      configPath = argument.slice('--config='.length);
    } else {
      errors.push(`Unrecognised argument '${argument}'.`);
    }
  }

  return Object.freeze({
    workspace: normalise(workspace),
    configPath: normalise(configPath),
    showVersion,
    showHelp,
    errors: Object.freeze(errors),
  });
}

/** Usage text, written to stderr. */
export function usageText() {
  return `${PROGRAM_NAME} - GenXEvo AI Automation Agent (JavaScript Selenium), an MCP server.

  --workspace, -w <path>   Directory the agent may read within. Required for any real work.
  --config,    -c <path>   Configuration file. Defaults to <workspace>/genxevo.config.json.
  --version,   -v          Print the version to stderr and exit.
  --help,      -h          Print this message to stderr and exit.

environment variables:
  GENXEVO_WORKSPACE                  Same as --workspace.
  GENXEVO_CONFIG                     Same as --config.
  GENXEVO_EXECUTION_ENABLED          true|false
  GENXEVO_EXECUTION_TIMEOUT_SECONDS  integer
  GENXEVO_BROWSER_HEADLESS           true|false
  GENXEVO_REDACT_SECRETS             true|false
  GENXEVO_NODE_EXECUTABLE            Node used to run the project's tests (phase 1D)

configuration file:
  <workspace>/genxevo.config.json

GenXEvo never infers the workspace. If none is supplied the server still starts,
and every capability returns a configurationError explaining exactly what to do.
`;
}

function takeValue(args, index) {
  const next = args[index + 1];
  if (next === undefined || next.startsWith('-')) return null;
  return next;
}

/** Trim whitespace and the quotes a shell or an MCP client configuration may leave behind. */
function normalise(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value)
    .trim()
    .replace(/^"+|"+$/g, '')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}
