/**
 * Everything about a GenXEvo installation that varies between machines and
 * projects.
 *
 * Nothing environment-specific is permitted anywhere else in GenXEvo source; it
 * all lives here. Defaults are chosen so that THE SAFEST CONFIGURATION IS THE
 * ONE YOU GET BY WRITING NOTHING: execution disabled, redaction on, framing on,
 * a required test selection, a bounded repair loop, an implicit wait of zero,
 * and no workspace root at all until an operator names one.
 *
 * THE FORMAT QUESTION, WHICH COSTS JAVASCRIPT NOTHING
 * `JSON.parse` is a language builtin, so `genxevo.config.json` needs no
 * dependency in `core` and the family's shared JSON shape works unchanged across
 * the C#, Python and JavaScript agents. The Java plan needs a two-implementation
 * `ConfigurationSource` interface to keep a parser out of its core, and Python
 * needs an ADR to justify TOML. Inventing an abstraction here by symmetry would
 * be the "abstraction that pays no rent" that Python's ADR-011 rejects.
 *
 * KEYS ARE camelCase. This lands on the same answer as the C# sibling, reached
 * independently by the same method Python used to reach a different one:
 * symmetry where a machine reads, nativeness where a human types. A JavaScript
 * engineer types camelCase in a `.json` file. RE-DERIVED, NOT COPIED.
 */

import { DEFAULT_DENIED_FILE_GLOBS, DEFAULT_IGNORED_DIRECTORIES } from '../security/denyList.js';
import { deepFreeze } from '../support/freeze.js';

/** @typedef {{path: string, message: string, fatal: boolean}} ConfigurationIssue */

/**
 * A problem found while validating configuration.
 *
 * Non-fatal issues are reported in every `genxevo_agent_status` call instead of
 * stopping the server, because some of them - redaction switched off, a non-zero
 * implicit wait - are legitimate operator choices that should simply never be
 * forgotten.
 */
export function configurationIssue(path, message, fatal) {
  return deepFreeze({ path, message, fatal });
}

export const DEFAULT_CONFIGURATION = deepFreeze({
  version: 1,

  workspace: {
    /** Absolute paths the agent may read and write within. Everything else is refused. */
    roots: [],
    ignoredDirectories: [...DEFAULT_IGNORED_DIRECTORIES],
    maxScanDepth: 12,
    maxScanEntries: 20_000,
  },

  /**
   * How to find the automation project inside the workspace.
   *
   * Every field is an escape hatch, and unlike the C# sibling's `ProjectOptions`
   * - which is entirely dead while its own docs, reasoning strings and a
   * `NextAction` all tell operators to set it - every one of these is actually
   * read by discovery.
   */
  project: {
    projectRoot: null,
    testRoots: [],
    /** `auto` | `npm` | `pnpm` | `yarn`. */
    packageManager: 'auto',
    /** `auto` | `mocha` | `jest` | `vitest` | `node` | `wdio`. */
    runner: 'auto',
    configFile: null,
    nodeExecutable: null,
  },

  execution: {
    /** Master switch. Off by default: running a project's tests runs that project's code. */
    enabled: false,
    runner: 'auto',
    defaultTimeoutSeconds: 900,
    maxConcurrentRuns: 1,
    /** True is what prevents an accidental full-suite run. */
    requireSelection: true,
    selectionMaxLength: 512,
    /**
     * Whether a discovered `package.json` script may be executed at all.
     *
     * FALSE by default, and this is JavaScript-specific. A script is a shell
     * command line: `"test": "playwright test"` is fine and
     * `"test": "rm -rf / && jest"` is equally valid JSON. When an operator turns
     * this on, the script text is shown in the result and in the run record,
     * redacted, before it runs.
     */
    useProjectScripts: false,
    environment: {},
  },

  browser: {
    /** `chrome` | `edge` | `firefox`. */
    kind: 'chrome',
    headless: false,
    /**
     * GenXEvo requires 0. An implicit wait compounds unpredictably with explicit
     * waits, which was a measured source of timing nondeterminism. A non-zero
     * value is accepted but reported every single time.
     */
    implicitWaitMs: 0,
    defaultTimeoutSeconds: 15,
    allowedOrigins: [],
    arguments: [],
    remoteUrl: null,
  },

  evidence: {
    directory: '.genxevo/evidence',
    screenshots: true,
    maxInlineHtmlCharacters: 20_000,
    maxInlineTextCharacters: 8_000,
    retentionRuns: 20,
  },

  security: {
    redactSecrets: true,
    additionalSecretKeyFragments: [],
    frameUntrustedContent: true,
    deniedFileGlobs: [...DEFAULT_DENIED_FILE_GLOBS],
  },

  repair: {
    maxCyclesPerFailure: 3,
    requireVerificationRun: true,
  },
});

const SECTION_NAMES = Object.freeze(
  Object.keys(DEFAULT_CONFIGURATION).filter((key) => key !== 'version'),
);

export { SECTION_NAMES };

/**
 * Validate the whole configuration.
 *
 * Callers must separate fatal from advisory rather than treating a non-empty
 * list as failure.
 *
 * @param {object} configuration
 * @returns {ConfigurationIssue[]}
 */
export function validateConfiguration(configuration) {
  const issues = [];
  const add = (path, message, fatal) => issues.push(configurationIssue(path, message, fatal));

  const { version, workspace, project, execution, browser, evidence, security, repair } =
    configuration;

  if (version !== 1) {
    add('version', `Unsupported configuration version ${version}. This build understands 1.`, true);
  }

  if (!Array.isArray(workspace.roots) || workspace.roots.length === 0) {
    add(
      'workspace.roots',
      'No workspace root is configured. GenXEvo refuses to guess which folder it may read.',
      true,
    );
  } else if (workspace.roots.some((root) => String(root ?? '').trim().length === 0)) {
    add('workspace.roots', 'A workspace root was empty.', true);
  }

  if (!between(workspace.maxScanDepth, 1, 64)) {
    add('workspace.maxScanDepth', 'Must be between 1 and 64.', true);
  }
  if (!between(workspace.maxScanEntries, 100, 1_000_000)) {
    add('workspace.maxScanEntries', 'Must be between 100 and 1000000.', true);
  }
  if (!Array.isArray(workspace.ignoredDirectories) || workspace.ignoredDirectories.length === 0) {
    // A permissive-empty setting that weakens a control must be loud. Both
    // siblings accept an empty list here in silence.
    add(
      'workspace.ignoredDirectories',
      'No directories are ignored, so a scan will descend into node_modules and build output. Expect a slow, truncated and unhelpful discovery result.',
      false,
    );
  }

  if (!['auto', 'npm', 'pnpm', 'yarn'].includes(project.packageManager)) {
    add('project.packageManager', "Must be 'auto', 'npm', 'pnpm' or 'yarn'.", true);
  }
  if (!['auto', 'mocha', 'jest', 'vitest', 'node', 'wdio'].includes(project.runner)) {
    add('project.runner', "Must be 'auto', 'mocha', 'jest', 'vitest', 'node' or 'wdio'.", true);
  }

  if (!['auto', 'mocha', 'jest', 'vitest', 'node', 'wdio'].includes(execution.runner)) {
    add('execution.runner', "Must be 'auto', 'mocha', 'jest', 'vitest', 'node' or 'wdio'.", true);
  }
  if (!between(execution.defaultTimeoutSeconds, 10, 7200)) {
    add('execution.defaultTimeoutSeconds', 'Must be between 10 and 7200 seconds.', true);
  }
  if (!between(execution.maxConcurrentRuns, 1, 4)) {
    add(
      'execution.maxConcurrentRuns',
      'Must be between 1 and 4. Concurrent runs against one application under test are rarely safe.',
      true,
    );
  }
  if (!between(execution.selectionMaxLength, 16, 4096)) {
    add('execution.selectionMaxLength', 'Must be between 16 and 4096.', true);
  }
  if (execution.requireSelection === false) {
    add(
      'execution.requireSelection',
      'A test selection is not required, so the agent may run the entire suite in one call. This is how an agent burns an hour and a shared test environment without learning anything.',
      false,
    );
  }
  if (execution.useProjectScripts === true) {
    add(
      'execution.useProjectScripts',
      'package.json scripts are enabled. A script is an arbitrary shell command line, not a test invocation; GenXEvo will show the script text before running it, but it cannot make it safe.',
      false,
    );
  }

  if (!['chrome', 'edge', 'firefox'].includes(browser.kind)) {
    add('browser.kind', "Must be 'chrome', 'edge' or 'firefox'.", true);
  }
  if (!between(browser.defaultTimeoutSeconds, 1, 300)) {
    add('browser.defaultTimeoutSeconds', 'Must be between 1 and 300 seconds.', true);
  }
  if (browser.implicitWaitMs !== 0) {
    add(
      'browser.implicitWaitMs',
      'Mixing an implicit wait with explicit waits produces unpredictable timing. GenXEvo requires 0.',
      false,
    );
  }

  if (!between(evidence.maxInlineHtmlCharacters, 500, 200_000)) {
    add('evidence.maxInlineHtmlCharacters', 'Must be between 500 and 200000.', true);
  }
  if (!between(evidence.maxInlineTextCharacters, 200, 200_000)) {
    add('evidence.maxInlineTextCharacters', 'Must be between 200 and 200000.', true);
  }
  if (!between(evidence.retentionRuns, 1, 1000)) {
    add('evidence.retentionRuns', 'Must be between 1 and 1000.', true);
  }

  if (!between(repair.maxCyclesPerFailure, 1, 20)) {
    add(
      'repair.maxCyclesPerFailure',
      'Must be between 1 and 20. An unbounded repair loop is the failure mode this setting exists to prevent.',
      true,
    );
  }

  if (security.redactSecrets === false) {
    add(
      'security.redactSecrets',
      'Secret redaction is disabled. Credentials in project configuration and in captured evidence will be sent to the AI model verbatim.',
      false,
    );
  }
  if (security.frameUntrustedContent === false) {
    add(
      'security.frameUntrustedContent',
      'Untrusted-content framing is disabled. Project and page content will reach the model with no trust label.',
      false,
    );
  }
  if (!Array.isArray(security.deniedFileGlobs) || security.deniedFileGlobs.length === 0) {
    // THE gap both siblings have. Python's `denied_file_globs = []` produces no
    // issue of any severity while status cheerfully reports
    // `deniedFileGlobCount: 0` - the silent removal of every credential-file
    // protection in the product.
    add(
      'security.deniedFileGlobs',
      'The deny list is EMPTY, so no file is protected. .npmrc, .env and private keys inside the workspace are all readable. This is almost never intended.',
      false,
    );
  }

  return issues;
}

function between(value, low, high) {
  return Number.isInteger(value) && value >= low && value <= high;
}
