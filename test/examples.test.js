import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_CONFIGURATION } from '../src/core/config/configuration.js';
import { CONFIG_FILE_NAME, loadConfiguration } from '../src/core/config/load.js';
import { tempWorkspace } from './helpers/fixtures.js';

/**
 * The configuration files this repository ships as examples ARE PART OF THE
 * PRODUCT: they are the first thing a new user copies. A stale example that no
 * longer parses is a broken onboarding path, so they are validated in CI like
 * any other code.
 *
 * The repository root is located from THIS FILE'S OWN PATH rather than by
 * walking up from somewhere looking for a familiar folder name. That
 * directory-walking heuristic is exactly the anti-pattern this product exists to
 * avoid, and it does not become acceptable because it is in a test.
 */
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..');

const EXAMPLES = [
  'genxevo.config.example.json',
  'examples/configs/minimal.genxevo.config.json',
  'examples/configs/ci.genxevo.config.json',
  'examples/configs/team.genxevo.config.json',
];

function loadExample(relative) {
  const workspace = tempWorkspace();
  fs.copyFileSync(path.join(REPOSITORY_ROOT, relative), path.join(workspace, CONFIG_FILE_NAME));
  return loadConfiguration({ workspaceOverride: workspace });
}

test('every shipped example exists', () => {
  for (const relative of [...EXAMPLES, '.mcp.json.example', 'examples/README.md']) {
    assert.ok(fs.existsSync(path.join(REPOSITORY_ROOT, relative)), relative);
  }
});

test('every shipped example parses, loads and has no FATAL problem', () => {
  for (const relative of EXAMPLES) {
    const result = loadExample(relative);
    assert.equal(result.loaded, true, `${relative}: ${result.error?.message ?? ''}`);
    assert.equal(result.issues.filter((i) => i.fatal).length, 0, relative);
  }
});

test('no shipped example contains an UNRECOGNISED key', () => {
  // A typo in an example is a typo in every project that copies it.
  for (const relative of EXAMPLES) {
    const unknown = loadExample(relative).issues.filter((issue) =>
      /is not a recognised/.test(issue.message),
    );
    assert.deepEqual(unknown, [], `${relative}: ${JSON.stringify(unknown)}`);
  }
});

test('the full example REALLY IS the defaults, setting by setting', () => {
  // The file claims every value in it is the built-in default. A documentation
  // file that lies is worse than none, because somebody will copy it.
  const loaded = loadExample('genxevo.config.example.json').configuration;
  for (const [section, defaults] of Object.entries(DEFAULT_CONFIGURATION)) {
    if (section === 'workspace' || typeof defaults !== 'object') continue;
    assert.deepEqual(loaded[section], defaults, section);
  }
  // The workspace section differs in exactly one way: roots is supplied at
  // runtime from --workspace.
  const { roots: _ignored, ...workspaceRest } = loaded.workspace;
  const { roots: _alsoIgnored, ...defaultRest } = DEFAULT_CONFIGURATION.workspace;
  assert.deepEqual(workspaceRest, defaultRest);
});

test('the full example names EVERY configuration section', () => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'genxevo.config.example.json'), 'utf8'),
  );
  for (const section of Object.keys(DEFAULT_CONFIGURATION)) {
    assert.ok(Object.hasOwn(raw, section), section);
  }
});

test('an example explains itself WITHOUT tripping the typo warning', () => {
  const result = loadExample('genxevo.config.example.json');
  assert.deepEqual(result.issues, [], JSON.stringify(result.issues));
});

test('the CI example is genuinely configured for unattended use, and says why', () => {
  const configuration = loadExample('examples/configs/ci.genxevo.config.json').configuration;
  assert.equal(configuration.browser.headless, true);
  assert.equal(configuration.execution.enabled, true);
  assert.equal(configuration.execution.requireSelection, true, 'even in CI, never the whole suite');
  assert.equal(configuration.execution.useProjectScripts, false);
  assert.equal(configuration.security.redactSecrets, true);

  // Turning execution on is a real risk and must be reported every time.
  const issues = loadExample('examples/configs/ci.genxevo.config.json').issues;
  assert.equal(issues.filter((i) => i.fatal).length, 0);
});

test('NO example contains a credential, a real host or an absolute personal path', () => {
  const forbidden = [
    /gh[pousr]_[A-Za-z0-9]{16,}/,
    /sk-[A-Za-z0-9]{20,}/,
    /xox[baprs]-[A-Za-z0-9-]{10,}/,
    /AKIA[0-9A-Z]{16}/,
    /npm_[A-Za-z0-9]{30,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /C:\\Users\\/i,
    /\/home\/[a-z0-9_.-]+\//i,
  ];
  for (const relative of [...EXAMPLES, '.mcp.json.example']) {
    const text = fs.readFileSync(path.join(REPOSITORY_ROOT, relative), 'utf8');
    for (const pattern of forbidden) {
      assert.equal(pattern.test(text), false, `${relative} matched ${pattern}`);
    }
  }
});

test('the MCP example is valid JSON and registers THIS server', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, '.mcp.json.example'), 'utf8'));
  assert.ok(raw.mcpServers);
  const entry = raw.mcpServers['genxevo-selenium'];
  assert.ok(entry, 'the primary entry must not be commented out');
  assert.ok(
    entry.args.includes('--workspace'),
    'the workspace is never inferred, so it must be passed',
  );
  assert.ok(entry.args.includes('@genxevo/genxevo-selenium-agent'));
});

test('the MCP example shows a zero-install form, which is what npx buys us', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, '.mcp.json.example'), 'utf8'));
  assert.equal(raw.mcpServers['genxevo-selenium'].command, 'npx');
});
