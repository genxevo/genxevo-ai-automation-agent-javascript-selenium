/**
 * Loading configuration, with a precedence an operator can reason about.
 *
 *   command line  ->  environment  ->  configuration file  ->  built-in defaults
 *
 * TWO RULES DO NOT BEND.
 *
 * THE WORKSPACE ROOT IS NEVER INFERRED. No directory-tree walking, no
 * `process.cwd()`, no `import.meta.dirname` heuristics. The implementation this
 * family learned from walked up looking for a folder literally named `src`, then
 * descended into a hard-coded sibling name; moved anywhere else, five of its
 * fifteen tools threw on every call. Convenience discovery is convenient exactly
 * once, on the machine it was written on.
 *
 * A MISSING CONFIGURATION FILE IS NOT AN ERROR, because the defaults ARE the
 * safe configuration.
 *
 * UNKNOWN KEYS ARE REPORTED, NEVER IGNORED. A silent binder turns
 * `redactSecret` into "redaction is on by default, so nothing looks wrong" while
 * the operator believes they configured something. Keys beginning with `_` are
 * exempt, because `"_comment"` is how a JSON file explains itself and warning
 * about it would train an operator to ignore the warnings that matter.
 *
 * THERE IS NO GENERIC KEY-PATH BINDER. With `GENXEVO__SECURITY__REDACTSECRETS`
 * available you can never be sure the file you are reading is the configuration
 * in force. Seven documented variables cover what genuinely varies per machine
 * and per CI job, and reading only those means a logging mistake cannot put
 * every secret on the machine into a transcript.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ErrorCategory } from '../contract/vocabularies.js';
import { ErrorCode } from '../contract/errorCodes.js';
import { agentError } from '../contract/agentError.js';
import { deepFreeze } from '../support/freeze.js';
import {
  DEFAULT_CONFIGURATION,
  SECTION_NAMES,
  configurationIssue,
  validateConfiguration,
} from './configuration.js';

export const CONFIG_FILE_NAME = 'genxevo.config.json';

/** The complete list. Only these are ever read from `process.env`. */
export const KNOWN_ENVIRONMENT_VARIABLES = Object.freeze([
  'GENXEVO_WORKSPACE',
  'GENXEVO_CONFIG',
  'GENXEVO_EXECUTION_ENABLED',
  'GENXEVO_EXECUTION_TIMEOUT_SECONDS',
  'GENXEVO_BROWSER_HEADLESS',
  'GENXEVO_REDACT_SECRETS',
  'GENXEVO_NODE_EXECUTABLE',
]);

/**
 * @typedef {object} LoadResult
 * @property {boolean} loaded
 * @property {object} configuration
 * @property {ConfigurationIssue[]} issues
 * @property {object} [error]
 * @property {string | null} sourcePath
 */

/**
 * @param {object} sources
 * @param {string} [sources.workspaceOverride]  From `--workspace`.
 * @param {string} [sources.configPathOverride] From `--config`.
 * @param {Record<string, string | undefined>} [sources.environment]
 * @returns {LoadResult}
 */
export function loadConfiguration({
  workspaceOverride,
  configPathOverride,
  environment = {},
} = {}) {
  const issues = [];

  const workspace = firstNonEmpty(workspaceOverride, environment.GENXEVO_WORKSPACE);
  const configPath = firstNonEmpty(configPathOverride, environment.GENXEVO_CONFIG);

  let root = workspace ? path.resolve(workspace) : null;
  let sourcePath = null;
  let fileValues = {};

  if (configPath) {
    const resolvedConfig = path.resolve(configPath);
    if (!existsAsFile(resolvedConfig)) {
      return unloadable(
        ErrorCode.CONFIG_NOT_FOUND,
        `The configuration file named on the command line does not exist: ${path.basename(resolvedConfig)}`,
        'Check the --config path, or omit it and let GenXEvo look for genxevo.config.json inside the workspace.',
        issues,
      );
    }
    const parsed = readJsonFile(resolvedConfig);
    if (!parsed.ok) {
      return unloadable(
        ErrorCode.CONFIG_INVALID,
        `The configuration file ${path.basename(resolvedConfig)} is not valid JSON.`,
        'Fix the JSON syntax. GenXEvo will not start from a file it cannot read, because a partially-applied security configuration is worse than none.',
        issues,
      );
    }
    fileValues = parsed.value;
    sourcePath = resolvedConfig;
    // An explicitly named config implies its own directory as the workspace when
    // no workspace was given, which is the only inference in the product and is
    // an explicit operator act rather than a heuristic.
    if (!root) root = path.dirname(resolvedConfig);
  } else if (root) {
    const candidate = path.join(root, CONFIG_FILE_NAME);
    if (existsAsFile(candidate)) {
      const parsed = readJsonFile(candidate);
      if (!parsed.ok) {
        return unloadable(
          ErrorCode.CONFIG_INVALID,
          `The configuration file ${CONFIG_FILE_NAME} in the workspace is not valid JSON.`,
          'Fix the JSON syntax, or delete the file to fall back to the safe defaults.',
          issues,
        );
      }
      fileValues = parsed.value;
      sourcePath = candidate;
    }
  }

  if (!root) {
    return unloadable(
      ErrorCode.WORKSPACE_NOT_CONFIGURED,
      'The agent is not configured: no workspace root has been approved.',
      'Start the GenXEvo agent with --workspace "<path to your automation project>", or set GENXEVO_WORKSPACE.',
      issues,
    );
  }

  if (!existsAsDirectory(root)) {
    return unloadable(
      ErrorCode.CONFIG_INVALID,
      'The configured workspace root is not an existing directory.',
      'Check the --workspace path. GenXEvo never falls back to the current directory.',
      issues,
    );
  }

  const merged = mergeSections(DEFAULT_CONFIGURATION, fileValues, issues);
  applyEnvironment(merged, environment, issues);

  // The named workspace is ALWAYS the first root, whatever the file said, so the
  // path that relative resolution is anchored to is the one the operator typed.
  const extraRoots = (merged.workspace.roots ?? [])
    .map((entry) => String(entry))
    .filter((entry) => entry.trim().length > 0)
    .map((entry) => (path.isAbsolute(entry) ? entry : path.resolve(root, entry)))
    .filter((entry) => path.resolve(entry) !== root);
  merged.workspace.roots = [root, ...extraRoots];

  const validationIssues = validateConfiguration(merged);
  issues.push(...validationIssues);

  const fatal = issues.filter((issue) => issue.fatal);
  if (fatal.length > 0) {
    return {
      loaded: false,
      configuration: DEFAULT_CONFIGURATION,
      issues: deepFreeze([...issues]),
      sourcePath,
      error: agentError({
        code: ErrorCode.CONFIG_INVALID,
        category: ErrorCategory.CONFIGURATION,
        message: `The configuration has ${fatal.length} fatal problem(s) and GenXEvo will not start from it.`,
        remediation: `Fix: ${fatal.map((issue) => issue.path).join(', ')}.`,
      }),
    };
  }

  return {
    loaded: true,
    configuration: deepFreeze(merged),
    issues: deepFreeze([...issues]),
    sourcePath,
  };
}

function unloadable(code, message, remediation, issues) {
  return {
    loaded: false,
    configuration: DEFAULT_CONFIGURATION,
    issues: deepFreeze([...issues]),
    sourcePath: null,
    error: agentError({
      code,
      category: ErrorCategory.CONFIGURATION,
      message,
      remediation,
    }),
  };
}

/**
 * Merge the file's values over the defaults, one section at a time, reporting
 * anything that was not recognised or was the wrong type.
 */
function mergeSections(defaults, fileValues, issues) {
  const merged = structuredClone(defaults);

  if (!isPlainObject(fileValues)) {
    issues.push(
      configurationIssue('(root)', 'The configuration file must contain a JSON object.', true),
    );
    return merged;
  }

  for (const [key, value] of Object.entries(fileValues)) {
    if (key.startsWith('_')) continue; // a comment, not a typo
    if (key === 'version') {
      if (Number.isInteger(value)) merged.version = value;
      else issues.push(configurationIssue('version', 'Must be an integer.', true));
      continue;
    }
    if (!SECTION_NAMES.includes(key)) {
      issues.push(
        configurationIssue(
          key,
          `'${key}' is not a recognised configuration section. Known sections: ${SECTION_NAMES.join(', ')}.`,
          false,
        ),
      );
      continue;
    }
    if (!isPlainObject(value)) {
      issues.push(
        configurationIssue(
          key,
          `'${key}' must be an object; the supplied value was ignored.`,
          false,
        ),
      );
      continue;
    }
    for (const [settingKey, settingValue] of Object.entries(value)) {
      if (settingKey.startsWith('_')) continue;
      const dotted = `${key}.${settingKey}`;
      if (!Object.hasOwn(merged[key], settingKey)) {
        issues.push(
          configurationIssue(
            dotted,
            `'${dotted}' is not a recognised setting and was ignored.`,
            false,
          ),
        );
        continue;
      }
      const expected = merged[key][settingKey];
      if (!typeMatches(expected, settingValue)) {
        issues.push(
          configurationIssue(
            dotted,
            `'${dotted}' expected ${describeType(expected)} but got ${describeType(settingValue)}; the default was kept.`,
            false,
          ),
        );
        continue;
      }
      merged[key][settingKey] = settingValue;
    }
  }
  return merged;
}

/** An unparseable environment value is ADVISORY, never fatal: a malformed CI variable must not stop the server starting. */
function applyEnvironment(merged, environment, issues) {
  const bool = (name, apply) => {
    const raw = environment[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return;
    const parsed = parseBoolean(raw);
    if (parsed === null) {
      issues.push(
        configurationIssue(name, `${name}='${raw}' is not a boolean and was ignored.`, false),
      );
      return;
    }
    apply(parsed);
  };

  bool('GENXEVO_EXECUTION_ENABLED', (v) => (merged.execution.enabled = v));
  bool('GENXEVO_BROWSER_HEADLESS', (v) => (merged.browser.headless = v));
  bool('GENXEVO_REDACT_SECRETS', (v) => (merged.security.redactSecrets = v));

  const timeout = environment.GENXEVO_EXECUTION_TIMEOUT_SECONDS;
  if (timeout !== undefined && timeout !== null && String(timeout).trim() !== '') {
    const parsed = Number(timeout);
    if (Number.isInteger(parsed)) merged.execution.defaultTimeoutSeconds = parsed;
    else
      issues.push(
        configurationIssue(
          'GENXEVO_EXECUTION_TIMEOUT_SECONDS',
          `GENXEVO_EXECUTION_TIMEOUT_SECONDS='${timeout}' is not an integer and was ignored.`,
          false,
        ),
      );
  }

  const nodeExecutable = environment.GENXEVO_NODE_EXECUTABLE;
  if (nodeExecutable && String(nodeExecutable).trim()) {
    merged.project.nodeExecutable = String(nodeExecutable).trim();
  }
}

function parseBoolean(raw) {
  const text = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  return null;
}

function typeMatches(expected, actual) {
  if (Array.isArray(expected)) return Array.isArray(actual);
  if (expected === null) return true; // nullable escape hatches accept a string or null
  if (typeof expected === 'boolean') return typeof actual === 'boolean';
  if (typeof expected === 'number') return Number.isInteger(actual);
  if (typeof expected === 'string') return typeof actual === 'string';
  if (isPlainObject(expected)) return isPlainObject(actual);
  return true;
}

function describeType(value) {
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  if (isPlainObject(value)) return 'an object';
  if (typeof value === 'number') return 'an integer';
  return `a ${typeof value}`;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim().length > 0) {
      return String(value).trim();
    }
  }
  return null;
}

function existsAsFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function existsAsDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function readJsonFile(candidate) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(candidate, 'utf8')) };
  } catch {
    return { ok: false };
  }
}

/** Read only the documented variables from the real process environment. */
export function readKnownEnvironment(env = process.env) {
  const result = {};
  for (const name of KNOWN_ENVIRONMENT_VARIABLES) result[name] = env[name];
  return result;
}
