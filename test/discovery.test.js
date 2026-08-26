import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ProjectDiscoveryService } from '../src/core/discovery/service.js';
import { importedPackages } from '../src/core/discovery/signals.js';
import { Confidence, TestRunner } from '../src/core/discovery/models.js';
import { WarningCode } from '../src/core/contract/warningCodes.js';
import { DEFAULT_CONFIGURATION } from '../src/core/config/configuration.js';
import { SecretRedactor } from '../src/core/security/redaction.js';
import {
  boundaryFor,
  seleniumProject,
  tempWorkspace,
  writeFile,
  writeJson,
} from './helpers/fixtures.js';

function discoverIn(root, overrides = {}) {
  const configuration = structuredClone(DEFAULT_CONFIGURATION);
  configuration.workspace.roots = [root];
  for (const [section, values] of Object.entries(overrides)) {
    Object.assign(configuration[section], values);
  }
  const boundary = boundaryFor(root);
  const service = new ProjectDiscoveryService({
    configuration,
    boundary,
    redactor: new SecretRedactor(),
  });
  return service.discover();
}

// -- nothing is assumed from a name ----------------------------------------

test('a test directory is found by its CONTENTS, not its name', async () => {
  const root = tempWorkspace();
  writeJson(root, 'package.json', { name: 'x', devDependencies: { mocha: '^11.0.0' } });
  writeFile(root, 'verification/checkout.spec.js', 'export default 1;');
  const { result } = await discoverIn(root);
  assert.deepEqual(result.summary.testRoots, ['verification']);
});

test('a directory CALLED test with no tests in it is not a test root', async () => {
  const root = tempWorkspace();
  writeJson(root, 'package.json', { name: 'x' });
  writeFile(root, 'test/readme.md', '# not a test');
  writeFile(root, 'test/helper.js', 'export const x = 1;');
  const { result } = await discoverIn(root);
  assert.deepEqual(result.summary.testRoots, []);
});

test("the project's OWN runner configuration is authoritative for test roots", async () => {
  const root = tempWorkspace();
  writeJson(root, 'package.json', { name: 'x', devDependencies: { mocha: '^11.0.0' } });
  writeJson(root, '.mocharc.json', { spec: ['suite/checks'] });
  writeFile(root, 'suite/checks/login.test.js', 'export default 1;');
  const { result } = await discoverIn(root);
  assert.deepEqual(result.summary.testRoots, ['suite/checks']);
  assert.equal(result.summary.testRootConfidence, Confidence.HIGH);
});

test('a page-object directory is found by its IMPORTS, not its name', async () => {
  const root = tempWorkspace();
  seleniumProject(root);
  const { result } = await discoverIn(root);
  assert.deepEqual(result.summary.pageObjectCandidates, ['suite/screens']);
});

test('a directory called pages with no browser code is NOT a page-object directory', async () => {
  const root = tempWorkspace();
  writeJson(root, 'package.json', { name: 'x' });
  writeFile(root, 'pages/about.js', "export const title = 'About';");
  const { result } = await discoverIn(root);
  assert.deepEqual(result.summary.pageObjectCandidates, []);
});

// -- the framework question the brief warns about ---------------------------

test('a WebdriverIO project is NOT reported as Selenium', async () => {
  // Section 14 of the brief is explicit: this must not silently become a
  // WebdriverIO agent. WebdriverIO is a different product with a different API.
  const root = tempWorkspace();
  writeJson(root, 'package.json', {
    name: 'wdio-suite',
    type: 'module',
    scripts: { wdio: 'wdio run ./wdio.conf.js' },
    devDependencies: { '@wdio/cli': '^8.11.2', '@wdio/mocha-framework': '^8.11.0' },
  });
  writeFile(root, 'wdio.conf.js', 'export const config = { specs: ["./test/**/*.js"] };');
  const { result, warnings } = await discoverIn(root);

  assert.deepEqual(result.summary.automationFrameworks, ['WebdriverIO']);
  assert.equal(result.summary.seleniumCompatible, false);
  assert.equal(result.summary.runner, TestRunner.WDIO, 'WebdriverIO owns the lifecycle, not mocha');
  const mismatch = warnings.find((w) => w.code === WarningCode.DISCOVERY_FRAMEWORK_MISMATCH);
  assert.ok(mismatch);
  assert.match(mismatch.detail, /not selenium-webdriver/);
});

test('a Playwright project is reported as Playwright and as NOT Selenium-compatible', async () => {
  const root = tempWorkspace();
  writeJson(root, 'package.json', {
    name: 'pw',
    scripts: { test: 'playwright test' },
    devDependencies: { '@playwright/test': '^1.60.0' },
  });
  const { result } = await discoverIn(root);
  assert.deepEqual(result.summary.automationFrameworks, ['Playwright']);
  assert.equal(result.summary.seleniumCompatible, false);
});

test('a real Selenium project is recognised from both a dependency and an import', async () => {
  const root = tempWorkspace();
  seleniumProject(root);
  const { result } = await discoverIn(root);
  assert.deepEqual(result.summary.automationFrameworks, ['Selenium']);
  assert.equal(result.summary.seleniumCompatible, true);
  assert.equal(result.summary.runner, TestRunner.MOCHA);
  assert.equal(result.summary.runnerConfidence, Confidence.HIGH);
});

test('no automation library at all is stated plainly', async () => {
  const root = tempWorkspace();
  writeJson(root, 'package.json', { name: 'plain' });
  const { result } = await discoverIn(root);
  assert.deepEqual(result.summary.automationFrameworks, []);
  assert.ok(result.summary.reasoning.some((line) => /No browser automation library/.test(line)));
});

// -- runner and package manager ---------------------------------------------

test('an unstated runner is reported as UNKNOWN, never guessed', async () => {
  const root = tempWorkspace();
  writeJson(root, 'package.json', { name: 'x' });
  const { result } = await discoverIn(root);
  assert.equal(result.summary.runner, TestRunner.UNKNOWN);
  assert.equal(result.summary.runnerConfidence, Confidence.NONE);
  assert.ok(result.summary.reasoning.some((line) => /rather than assuming one/.test(line)));
});

test('two runners present is reported as ambiguous rather than resolved', async () => {
  const root = tempWorkspace();
  writeJson(root, 'package.json', {
    name: 'x',
    devDependencies: { mocha: '^11.0.0', vitest: '^4.0.0' },
  });
  const { result, warnings } = await discoverIn(root);
  assert.equal(result.summary.runner, TestRunner.UNKNOWN);
  assert.equal(result.summary.runnerConfidence, Confidence.LOW);
  assert.ok(warnings.some((w) => w.code === WarningCode.DISCOVERY_TOOLCHAIN_MISMATCH));
});

test('the operator overriding the runner beats discovery', async () => {
  const root = tempWorkspace();
  writeJson(root, 'package.json', { name: 'x', devDependencies: { mocha: '^11.0.0' } });
  const { result } = await discoverIn(root, { project: { runner: 'vitest' } });
  assert.equal(result.summary.runner, 'vitest');
  assert.equal(result.summary.runnerConfidence, Confidence.HIGH);
});

test('the package manager comes from the lockfile, and the packageManager field confirms it', async () => {
  const root = tempWorkspace();
  writeJson(root, 'package.json', { name: 'x', packageManager: 'npm@11.12.1' });
  writeJson(root, 'package-lock.json', { lockfileVersion: 3 });
  const { result } = await discoverIn(root);
  assert.equal(result.summary.packageManager, 'npm');
  assert.equal(result.summary.packageManagerConfidence, Confidence.HIGH);
});

test('DECLARED IS NOT INSTALLED: a packageManager field the lockfile contradicts is flagged', async () => {
  // Observed for real: a project declaring `pnpm@9.15.4` on a machine whose
  // installed pnpm is 11.9.0 and where Corepack has never run.
  const root = tempWorkspace();
  writeJson(root, 'package.json', { name: 'x', packageManager: 'pnpm@9.15.4' });
  writeJson(root, 'package-lock.json', { lockfileVersion: 3 });
  const { result, warnings } = await discoverIn(root);
  assert.equal(result.summary.packageManager, 'npm');
  assert.equal(result.summary.packageManagerConfidence, Confidence.MEDIUM);
  assert.ok(warnings.some((w) => w.code === WarningCode.DISCOVERY_TOOLCHAIN_MISMATCH));
});

test('two lockfiles is ambiguous, and installing with the wrong one is called out', async () => {
  const root = tempWorkspace();
  writeJson(root, 'package.json', { name: 'x' });
  writeJson(root, 'package-lock.json', {});
  writeFile(root, 'pnpm-lock.yaml', 'lockfileVersion: 9.0');
  const { result, warnings } = await discoverIn(root);
  assert.equal(result.summary.packageManager, 'unknown');
  const warning = warnings.find((w) => w.code === WarningCode.DISCOVERY_TOOLCHAIN_MISMATCH);
  assert.match(warning.detail, /rewrites the other/);
});

// -- the toolchain ----------------------------------------------------------

test('the toolchain reports the declared range, the pin and its SOURCE', async () => {
  const root = tempWorkspace();
  seleniumProject(root);
  const { result } = await discoverIn(root);
  assert.equal(result.toolchain.declaredNodeRange, '>=22.0.0');
  assert.equal(result.toolchain.pinnedNodeVersion, '24');
  assert.equal(result.toolchain.pinnedNodeVersionSource, '.nvmrc');
  assert.equal(result.summary.moduleSystem, 'module');
});

test('the module system is read, not assumed', async () => {
  const commonjs = tempWorkspace();
  writeJson(commonjs, 'package.json', { name: 'x', type: 'commonjs' });
  assert.equal((await discoverIn(commonjs)).result.summary.moduleSystem, 'commonjs');

  const undeclared = tempWorkspace();
  writeJson(undeclared, 'package.json', { name: 'x' });
  assert.equal((await discoverIn(undeclared)).result.summary.moduleSystem, 'undeclared');
});

test('what is INSTALLED is read from node_modules/.package-lock.json, by direct path', async () => {
  const root = tempWorkspace();
  seleniumProject(root);
  const { result } = await discoverIn(root);
  assert.deepEqual(result.toolchain.installedNotable, [
    'mocha@11.8.0',
    'selenium-webdriver@4.47.0',
  ]);
  assert.equal(result.toolchain.installedStateSource, 'node_modules/.package-lock.json');
});

test('node_modules is NEVER WALKED', async () => {
  // The mirror of Python's ADR-017, answered the other way: in JavaScript the
  // declared truth is already in two small files at the root, so the expensive
  // tree buys nothing - but the cheap authoritative file inside it is read.
  const root = tempWorkspace();
  seleniumProject(root);
  for (let i = 0; i < 40; i += 1) {
    writeJson(root, `node_modules/pkg${i}/package.json`, { name: `pkg${i}` });
    writeFile(root, `node_modules/pkg${i}/index.test.js`, 'x');
  }
  const { result } = await discoverIn(root);
  assert.equal(
    result.directories.some((d) => d.path.startsWith('node_modules')),
    false,
  );
  assert.equal(
    result.summary.testRoots.some((r) => r.startsWith('node_modules')),
    false,
  );
  assert.equal(
    result.manifests.some((m) => m.path.startsWith('node_modules')),
    false,
  );
});

test('missing installed state is reported honestly rather than as "nothing installed"', async () => {
  const root = tempWorkspace();
  writeJson(root, 'package.json', { name: 'x', devDependencies: { mocha: '^11.0.0' } });
  const { result } = await discoverIn(root);
  assert.equal(result.toolchain.installedStateSource, null);
  assert.deepEqual(result.toolchain.installedNotable, []);
  assert.ok(
    result.summary.reasoning.some((line) => /but not what is actually installed/.test(line)),
  );
});

// -- nothing in the project is executed --------------------------------------

test('NOTHING IN THE PROJECT IS EXECUTED', async () => {
  // The planted-marker technique, ported verbatim from the Python sibling. It is
  // the single most reusable asset in that repository.
  const root = tempWorkspace();
  const marker = path.join(root, 'EXECUTED');
  const bomb = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`;

  writeJson(root, 'package.json', {
    name: 'hostile',
    scripts: {
      preinstall: `node -e "${bomb}"`,
      postinstall: `node -e "${bomb}"`,
      test: `node -e "${bomb}"`,
    },
    devDependencies: { mocha: '^11.0.0' },
  });
  writeFile(root, 'wdio.conf.js', bomb);
  writeFile(root, 'jest.config.js', bomb);
  writeFile(root, '.mocharc.js', bomb);
  writeFile(root, 'vitest.config.ts', bomb);
  writeFile(root, 'suite/setup.js', bomb);

  const { result } = await discoverIn(root);

  assert.equal(fs.existsSync(marker), false, 'a lifecycle script or a config file was EXECUTED');
  // The configs are still recorded as present - the evidence is that they exist.
  assert.ok(result.runnerConfigs.some((c) => c.kind === 'wdio.conf.js'));
  assert.ok(result.runnerConfigs.every((c) => c.kind.endsWith('.json') || c.parsed === false));
});

test('an executable runner config is recorded as present and SAYS it was not evaluated', async () => {
  const root = tempWorkspace();
  writeJson(root, 'package.json', { name: 'x' });
  writeFile(root, 'wdio.conf.js', 'export const config = {};');
  const { result } = await discoverIn(root);
  const config = result.runnerConfigs.find((c) => c.kind === 'wdio.conf.js');
  assert.equal(config.parsed, false);
  assert.match(config.note, /never evaluates it/);
});

test('script BODIES are never emitted, only the script names and the runner they imply', async () => {
  // A script line is a shell command and may carry a token.
  const root = tempWorkspace();
  writeJson(root, 'package.json', {
    name: 'x',
    scripts: {
      test: 'mocha',
      deploy: 'node deploy.js --token=npm_abcdefghijklmnopqrstuvwxyz012345',
    },
  });
  const { result } = await discoverIn(root);
  assert.deepEqual(result.toolchain.scriptNames, ['deploy', 'test']);
  assert.equal(JSON.stringify(result).includes('npm_abcdefghij'), false);
  assert.equal(JSON.stringify(result).includes('deploy.js --token'), false);
});

// -- the security controls are WIRED --------------------------------------

test('a deny-listed file inside the workspace is NOT READ during discovery', async () => {
  // Python's discovery reads every .py file directly while its deny-list claims
  // to protect the ones holding Django secrets. Here the deny-list is a property
  // of EVERY read, not only of agent-supplied paths.
  const root = tempWorkspace();
  seleniumProject(root);
  writeFile(root, '.npmrc', '//registry.npmjs.org/:_authToken=npm_MUSTNEVERBEREAD0123456789012');
  writeFile(root, 'suite/screens/.env', 'DB_PASSWORD=hunter2');
  const { result } = await discoverIn(root);
  const rendered = JSON.stringify(result);
  assert.equal(rendered.includes('MUSTNEVERBEREAD'), false);
  assert.equal(rendered.includes('hunter2'), false);
});

test('a secret inside package.json is REDACTED before it can reach a result', async () => {
  const root = tempWorkspace();
  seleniumProject(root, { config: { uatPassword: 'Winter2026!' } });
  const { result } = await discoverIn(root);
  assert.equal(JSON.stringify(result).includes('Winter2026'), false);
});

test('EVERY path in the result is workspace-relative', async () => {
  const root = tempWorkspace();
  seleniumProject(root);
  const { result } = await discoverIn(root);
  assert.equal(JSON.stringify(result).includes(root), false);
  for (const manifest of result.manifests) assert.equal(path.isAbsolute(manifest.path), false);
  for (const directory of result.directories) assert.equal(path.isAbsolute(directory.path), false);
});

// -- honesty about limits ---------------------------------------------------

test('hitting the DEPTH limit is reported as truncation', async () => {
  const root = tempWorkspace();
  writeJson(root, 'package.json', { name: 'x' });
  writeFile(root, 'a/b/c/d/e/f/deep.test.js', 'x');
  const { result, warnings } = await discoverIn(root, { workspace: { maxScanDepth: 2 } });
  assert.equal(result.scan.truncated, true);
  assert.ok(warnings.some((w) => w.code === WarningCode.DISCOVERY_SCAN_LIMIT_REACHED));
});

test('hitting the ENTRY limit is reported as truncation', async () => {
  const root = tempWorkspace();
  writeJson(root, 'package.json', { name: 'x' });
  for (let i = 0; i < 12; i += 1) writeFile(root, `d${i}/a.js`, 'x');
  const { result } = await discoverIn(root, { workspace: { maxScanEntries: 3 } });
  assert.equal(result.scan.truncated, true);
});

test('ignored directories are not scanned', async () => {
  const root = tempWorkspace();
  writeJson(root, 'package.json', { name: 'x' });
  writeFile(root, 'dist/bundle.test.js', 'x');
  writeFile(root, 'coverage/report.test.js', 'x');
  const { result } = await discoverIn(root);
  assert.deepEqual(result.summary.testRoots, []);
});

test('a SYMLINKED directory is not followed', async () => {
  const root = tempWorkspace();
  const outside = tempWorkspace();
  writeFile(outside, 'sneaky.test.js', 'x');
  writeJson(root, 'package.json', { name: 'x' });
  fs.symlinkSync(outside, path.join(root, 'link'), 'dir');
  const { result } = await discoverIn(root);
  assert.deepEqual(result.summary.testRoots, []);
});

test('an unparseable package.json is reported, never read as "no dependencies"', async () => {
  const root = tempWorkspace();
  writeFile(root, 'package.json', '{ "name": broken }');
  const { result, warnings } = await discoverIn(root);
  assert.equal(result.manifests[0].parsed, false);
  const warning = warnings.find((w) => w.code === WarningCode.DISCOVERY_MANIFEST_UNREADABLE);
  assert.match(warning.detail, /do NOT read this as "no dependencies"/);
});

test('an empty workspace produces an empty but valid result', async () => {
  const { result } = await discoverIn(tempWorkspace());
  assert.deepEqual(result.manifests, []);
  assert.equal(result.summary.runner, TestRunner.UNKNOWN);
  assert.equal(result.scan.truncated, false);
});

test('a scan can be CANCELLED', async () => {
  const root = tempWorkspace();
  writeJson(root, 'package.json', { name: 'x' });
  for (let i = 0; i < 30; i += 1) writeFile(root, `d${i}/a.js`, 'x');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(async () => {
    const configuration = structuredClone(DEFAULT_CONFIGURATION);
    configuration.workspace.roots = [root];
    await new ProjectDiscoveryService({
      configuration,
      boundary: boundaryFor(root),
      redactor: new SecretRedactor(),
    }).discover(controller.signal);
  });
});

// -- import detection --------------------------------------------------------

test('imports are detected in every JavaScript form, without executing anything', () => {
  const source = [
    "import { Builder, By } from 'selenium-webdriver';",
    "const chrome = require('selenium-webdriver/chrome');",
    "export { helper } from '@wdio/cli/dist/x';",
    "const pw = await import('@playwright/test');",
    "import 'side-effect-only';",
    "import fs from 'node:fs';",
    "import local from './helper.js';",
  ].join('\n');
  assert.deepEqual([...importedPackages(source)].sort(), [
    '@playwright/test',
    '@wdio/cli',
    'selenium-webdriver',
    'side-effect-only',
  ]);
});

test('import detection over a large file stays bounded', () => {
  const started = performance.now();
  importedPackages('const a = 1;\n'.repeat(40_000));
  assert.ok(performance.now() - started < 1_000);
});
