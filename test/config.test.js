import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  DEFAULT_CONFIGURATION,
  SECTION_NAMES,
  validateConfiguration,
} from '../src/core/config/configuration.js';
import {
  CONFIG_FILE_NAME,
  KNOWN_ENVIRONMENT_VARIABLES,
  loadConfiguration,
  readKnownEnvironment,
} from '../src/core/config/load.js';
import { ErrorCode } from '../src/core/contract/errorCodes.js';
import { tempWorkspace, writeFile, writeJson } from './helpers/fixtures.js';

test('WRITING NOTHING gives the safest configuration', () => {
  const defaults = DEFAULT_CONFIGURATION;
  assert.equal(defaults.execution.enabled, false, 'running a project runs that project code');
  assert.equal(defaults.execution.requireSelection, true);
  assert.equal(defaults.execution.useProjectScripts, false, 'a script is a shell command line');
  assert.equal(defaults.security.redactSecrets, true);
  assert.equal(defaults.security.frameUntrustedContent, true);
  assert.equal(defaults.browser.implicitWaitMs, 0);
  assert.equal(defaults.repair.maxCyclesPerFailure, 3);
  assert.deepEqual(defaults.workspace.roots, [], 'no root until an operator names one');
  assert.ok(defaults.security.deniedFileGlobs.length > 10);
});

test('node_modules is ignored, and the JavaScript build output with it', () => {
  const ignored = DEFAULT_CONFIGURATION.workspace.ignoredDirectories;
  for (const name of ['node_modules', 'dist', 'coverage', 'playwright-report', '.genxevo']) {
    assert.ok(ignored.includes(name), name);
  }
});

test('validation: no workspace root is FATAL', () => {
  const issues = validateConfiguration(DEFAULT_CONFIGURATION);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, 'workspace.roots');
  assert.equal(issues[0].fatal, true);
});

test('validation: a configured workspace validates cleanly', () => {
  const configured = withRoots(tempWorkspace());
  assert.deepEqual(validateConfiguration(configured), []);
});

test('validation: out-of-range settings are fatal and NAME the setting', () => {
  const cases = [
    ['workspace', 'maxScanDepth', 0],
    ['workspace', 'maxScanEntries', 5],
    ['execution', 'defaultTimeoutSeconds', 5],
    ['execution', 'maxConcurrentRuns', 9],
    ['execution', 'selectionMaxLength', 1],
    ['browser', 'defaultTimeoutSeconds', 9999],
    ['evidence', 'retentionRuns', 0],
    ['repair', 'maxCyclesPerFailure', 99],
  ];
  for (const [section, key, value] of cases) {
    const configuration = withRoots(tempWorkspace(), { [section]: { [key]: value } });
    const issues = validateConfiguration(configuration).filter((i) => i.fatal);
    assert.ok(
      issues.some((issue) => issue.path === `${section}.${key}`),
      `${section}.${key}`,
    );
  }
});

test('validation: an unsupported version is fatal', () => {
  const configuration = { ...withRoots(tempWorkspace()), version: 2 };
  assert.ok(validateConfiguration(configuration).some((i) => i.path === 'version' && i.fatal));
});

test('validation: enumerated settings are checked', () => {
  for (const [section, key, value] of [
    ['project', 'packageManager', 'bun'],
    ['project', 'runner', 'ava'],
    ['browser', 'kind', 'safari'],
  ]) {
    const configuration = withRoots(tempWorkspace(), { [section]: { [key]: value } });
    assert.ok(validateConfiguration(configuration).some((i) => i.path === `${section}.${key}`));
  }
});

test('validation: legitimate but risky choices are ADVISORY, not fatal', () => {
  const configuration = withRoots(tempWorkspace(), {
    security: { redactSecrets: false, frameUntrustedContent: false },
    browser: { implicitWaitMs: 5000 },
    execution: { requireSelection: false, useProjectScripts: true },
  });
  const issues = validateConfiguration(configuration);
  assert.equal(issues.filter((i) => i.fatal).length, 0);
  for (const expected of [
    'security.redactSecrets',
    'security.frameUntrustedContent',
    'browser.implicitWaitMs',
    'execution.requireSelection',
    'execution.useProjectScripts',
  ]) {
    assert.ok(
      issues.some((i) => i.path === expected),
      expected,
    );
  }
});

test('validation: a PERMISSIVE-EMPTY setting that weakens a control is LOUD', () => {
  // The gap both siblings have. Python's `denied_file_globs = []` produces no
  // issue of any severity while status reports `deniedFileGlobCount: 0` - the
  // silent removal of every credential-file protection in the product.
  const configuration = withRoots(tempWorkspace(), {
    security: { deniedFileGlobs: [] },
    workspace: { ignoredDirectories: [] },
  });
  const issues = validateConfiguration(configuration);
  const denied = issues.find((i) => i.path === 'security.deniedFileGlobs');
  assert.ok(denied, 'an empty deny-list must never be silent');
  assert.match(denied.message, /EMPTY/);
  assert.ok(issues.some((i) => i.path === 'workspace.ignoredDirectories'));
});

test('the loader REFUSES TO GUESS when no workspace is supplied anywhere', () => {
  const result = loadConfiguration({});
  assert.equal(result.loaded, false);
  assert.equal(result.error.code, ErrorCode.WORKSPACE_NOT_CONFIGURED);
  assert.match(result.error.remediation, /--workspace/);
});

test('the process working directory is NEVER used as a fallback', () => {
  const before = process.cwd();
  const elsewhere = tempWorkspace();
  writeJson(elsewhere, 'package.json', { name: 'tempting' });
  try {
    process.chdir(elsewhere);
    assert.equal(loadConfiguration({}).loaded, false);
    assert.equal(loadConfiguration({ environment: {} }).loaded, false);
  } finally {
    process.chdir(before);
  }
});

test('a workspace that does not exist is refused', () => {
  const result = loadConfiguration({ workspaceOverride: path.join(tempWorkspace(), 'nope') });
  assert.equal(result.loaded, false);
  assert.equal(result.error.code, ErrorCode.CONFIG_INVALID);
});

test('precedence: the command line beats the environment', () => {
  const chosen = tempWorkspace();
  const ignored = tempWorkspace();
  const result = loadConfiguration({
    workspaceOverride: chosen,
    environment: { GENXEVO_WORKSPACE: ignored },
  });
  assert.equal(result.configuration.workspace.roots[0], chosen);
});

test('precedence: the environment is used when the command line is silent', () => {
  const root = tempWorkspace();
  const result = loadConfiguration({ environment: { GENXEVO_WORKSPACE: root } });
  assert.equal(result.configuration.workspace.roots[0], root);
});

test('precedence: the environment beats the configuration file', () => {
  const root = tempWorkspace();
  writeJson(root, CONFIG_FILE_NAME, { security: { redactSecrets: false } });
  const result = loadConfiguration({
    workspaceOverride: root,
    environment: { GENXEVO_REDACT_SECRETS: 'true' },
  });
  assert.equal(result.configuration.security.redactSecrets, true);
});

test('the NAMED workspace is always the first root', () => {
  const root = tempWorkspace();
  writeJson(root, CONFIG_FILE_NAME, { workspace: { roots: ['packages/app'] } });
  const result = loadConfiguration({ workspaceOverride: root });
  assert.equal(result.configuration.workspace.roots[0], root);
  assert.equal(result.configuration.workspace.roots.length, 2);
});

test('a missing configuration file is NOT an error', () => {
  const result = loadConfiguration({ workspaceOverride: tempWorkspace() });
  assert.equal(result.loaded, true);
  assert.equal(result.sourcePath, null);
  assert.deepEqual(result.issues, []);
});

test('a config file named on the command line MUST exist', () => {
  const result = loadConfiguration({
    configPathOverride: path.join(tempWorkspace(), 'nope.json'),
  });
  assert.equal(result.error.code, ErrorCode.CONFIG_NOT_FOUND);
});

test('malformed JSON is a configuration error naming the file', () => {
  const root = tempWorkspace();
  writeFile(root, CONFIG_FILE_NAME, '{ not json');
  const result = loadConfiguration({ workspaceOverride: root });
  assert.equal(result.loaded, false);
  assert.equal(result.error.code, ErrorCode.CONFIG_INVALID);
  assert.match(result.error.message, /genxevo\.config\.json/);
});

test('an explicit --config implies its own directory as the workspace', () => {
  const root = tempWorkspace();
  const file = writeJson(root, 'custom.json', { security: { redactSecrets: true } });
  const result = loadConfiguration({ configPathOverride: file });
  assert.equal(result.loaded, true);
  assert.equal(result.configuration.workspace.roots[0], root);
});

test('an unrecognised key is REPORTED, not silently ignored', () => {
  // A silent binder turns `redactSecret` into "redaction is on by default, so
  // nothing looks wrong" while the operator believes they configured something.
  const root = tempWorkspace();
  writeJson(root, CONFIG_FILE_NAME, {
    bogusSection: { x: 1 },
    security: { redactSecret: false },
  });
  const issues = loadConfiguration({ workspaceOverride: root }).issues;
  assert.ok(issues.some((i) => i.path === 'bogusSection'));
  assert.ok(issues.some((i) => i.path === 'security.redactSecret'));
  assert.equal(
    issues.every((i) => !i.fatal),
    true,
    'a typo is advisory, not fatal',
  );
});

test('an underscore-prefixed key is a COMMENT, not a typo', () => {
  // JSON has no comments, and warning about `_comment` would train an operator
  // to ignore the warnings that matter.
  const root = tempWorkspace();
  writeJson(root, CONFIG_FILE_NAME, {
    _comment: 'this file explains itself',
    security: { _note: 'and so does this section', redactSecrets: true },
  });
  assert.deepEqual(loadConfiguration({ workspaceOverride: root }).issues, []);
});

test('a type mismatch keeps the default and SAYS SO', () => {
  const root = tempWorkspace();
  writeJson(root, CONFIG_FILE_NAME, {
    execution: { defaultTimeoutSeconds: 'soon', enabled: 1 },
    security: { deniedFileGlobs: 'everything' },
  });
  const result = loadConfiguration({ workspaceOverride: root });
  assert.equal(result.configuration.execution.defaultTimeoutSeconds, 900);
  assert.equal(result.configuration.execution.enabled, false);
  assert.ok(result.issues.some((i) => i.path === 'execution.defaultTimeoutSeconds'));
  assert.ok(result.issues.some((i) => i.path === 'execution.enabled'));
  assert.ok(result.issues.some((i) => i.path === 'security.deniedFileGlobs'));
});

test('a section given a scalar is reported rather than crashing', () => {
  const root = tempWorkspace();
  writeJson(root, CONFIG_FILE_NAME, { security: 'yes please' });
  assert.ok(
    loadConfiguration({ workspaceOverride: root }).issues.some((i) => i.path === 'security'),
  );
});

test('a FATAL setting stops the load and names every offender', () => {
  const root = tempWorkspace();
  writeJson(root, CONFIG_FILE_NAME, {
    execution: { defaultTimeoutSeconds: 1, maxConcurrentRuns: 99 },
  });
  const result = loadConfiguration({ workspaceOverride: root });
  assert.equal(result.loaded, false);
  assert.match(result.error.remediation, /execution\.defaultTimeoutSeconds/);
  assert.match(result.error.remediation, /execution\.maxConcurrentRuns/);
});

test('the documented environment variable list is complete and unique', () => {
  assert.equal(new Set(KNOWN_ENVIRONMENT_VARIABLES).size, KNOWN_ENVIRONMENT_VARIABLES.length);
  assert.equal(KNOWN_ENVIRONMENT_VARIABLES.length, 7);
  for (const name of KNOWN_ENVIRONMENT_VARIABLES) assert.match(name, /^GENXEVO_[A-Z_]+$/);
});

test('ONLY the documented variables are read from the process environment', () => {
  // Reading the whole environment would put every secret on the machine one
  // logging mistake away from a transcript.
  const read = readKnownEnvironment({ GENXEVO_WORKSPACE: '/x', AWS_SECRET_ACCESS_KEY: 'nope' });
  assert.deepEqual(Object.keys(read).sort(), [...KNOWN_ENVIRONMENT_VARIABLES].sort());
  assert.equal(Object.hasOwn(read, 'AWS_SECRET_ACCESS_KEY'), false);
});

test('truthy spellings are accepted for boolean variables', () => {
  const root = tempWorkspace();
  for (const value of ['true', 'TRUE', '1', 'yes', 'on']) {
    assert.equal(
      loadConfiguration({
        workspaceOverride: root,
        environment: { GENXEVO_EXECUTION_ENABLED: value },
      }).configuration.execution.enabled,
      true,
      value,
    );
  }
  for (const value of ['false', '0', 'no', 'off']) {
    assert.equal(
      loadConfiguration({
        workspaceOverride: root,
        environment: { GENXEVO_EXECUTION_ENABLED: value },
      }).configuration.execution.enabled,
      false,
      value,
    );
  }
});

test('an unparseable environment variable is ADVISORY, never fatal', () => {
  // A malformed CI variable must not stop the server starting.
  const root = tempWorkspace();
  const result = loadConfiguration({
    workspaceOverride: root,
    environment: { GENXEVO_EXECUTION_TIMEOUT_SECONDS: 'soon', GENXEVO_BROWSER_HEADLESS: 'maybe' },
  });
  assert.equal(result.loaded, true);
  assert.equal(result.configuration.execution.defaultTimeoutSeconds, 900);
  assert.ok(result.issues.some((i) => i.path === 'GENXEVO_EXECUTION_TIMEOUT_SECONDS' && !i.fatal));
  assert.ok(result.issues.some((i) => i.path === 'GENXEVO_BROWSER_HEADLESS' && !i.fatal));
});

test('every section is reachable from the loader', () => {
  assert.deepEqual([...SECTION_NAMES].sort(), [
    'browser',
    'evidence',
    'execution',
    'project',
    'repair',
    'security',
    'workspace',
  ]);
});

function withRoots(root, overrides = {}) {
  const configuration = structuredClone(DEFAULT_CONFIGURATION);
  configuration.workspace.roots = [root];
  for (const [section, values] of Object.entries(overrides)) {
    Object.assign(configuration[section], values);
  }
  return configuration;
}
