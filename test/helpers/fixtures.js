/**
 * Shared test fixtures.
 *
 * Every test that touches the filesystem builds a REAL temporary directory
 * rather than a fake. That is Python's ADR-011 re-derived for JavaScript: an
 * injected filesystem interface with one implementation, added because another
 * language needed one, pays no rent — and testing against the real filesystem
 * catches symlink resolution, junction behaviour, permission errors and platform
 * case-sensitivity that a fake cannot. Those are exactly the behaviours this
 * product's security surface depends on.
 *
 * The only injected collaborators are the clock and the token source, because
 * run identifiers and timestamps are part of the PUBLISHED CONTRACT and a
 * contract that cannot be pinned in a test is a contract that drifts. That is a
 * reason, not a habit.
 *
 * Every credential-shaped literal in this repository is SYNTHETIC. `Winter2026!`
 * and `hunter2` are invented; the JWT is the textbook HS256 example whose
 * payload is `{"sub":"12345"}` and which signs nothing; the PEM body is
 * literally digits and the alphabet; `example.com`, `example.test` and
 * `example.invalid` are RFC 2606 reserved names. Nothing here is real and
 * nothing here has ever been valid anywhere.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PathBoundary } from '../../src/core/security/pathBoundary.js';
import { DEFAULT_DENIED_FILE_GLOBS } from '../../src/core/security/denyList.js';
import { SecretRedactor } from '../../src/core/security/redaction.js';

/** A real, canonicalised temporary directory. Canonicalised so macOS `/private` does not confuse containment. */
export function tempWorkspace(prefix = 'genxevo-test-') {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Write a file, creating parents. */
export function writeFile(root, relative, contents) {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, 'utf8');
  return target;
}

export function writeJson(root, relative, value) {
  return writeFile(root, relative, JSON.stringify(value, null, 2));
}

/** A boundary with the product's real deny-list, over a real directory. */
export function boundaryFor(root, options = {}) {
  return new PathBoundary([root], { deniedGlobs: DEFAULT_DENIED_FILE_GLOBS, ...options });
}

export function readDeps(root) {
  return { boundary: boundaryFor(root), redactor: new SecretRedactor() };
}

/**
 * A synthetic JavaScript + Selenium project.
 *
 * It has to be synthetic: there is no JavaScript + Selenium project on the
 * machine this product is verified against. The estate there is Playwright,
 * TypeScript and WebdriverIO — which is itself the reason
 * `test_a_webdriverio_project_is_not_reported_as_selenium` exists.
 */
export function seleniumProject(root, overrides = {}) {
  writeJson(root, 'package.json', {
    name: 'acme-regression',
    private: true,
    type: 'module',
    engines: { node: '>=22.0.0' },
    scripts: { test: 'mocha "suite/checks/**/*.test.js"' },
    devDependencies: { mocha: '^11.8.0', 'selenium-webdriver': '4.47.0' },
    ...overrides,
  });
  writeJson(root, 'package-lock.json', { name: 'acme-regression', lockfileVersion: 3 });
  writeJson(root, '.mocharc.json', { spec: ['suite/checks'] });
  writeFile(root, '.nvmrc', 'v24\n');
  writeFile(
    root,
    'suite/checks/login.test.js',
    "import { Builder } from 'selenium-webdriver';\nimport { LOGIN } from '../screens/loginScreen.js';\n",
  );
  writeFile(
    root,
    'suite/screens/loginScreen.js',
    "import { By } from 'selenium-webdriver';\nexport const PASSWORD_FIELD = By.id('txtPassword');\n",
  );
  writeJson(root, 'node_modules/.package-lock.json', {
    packages: {
      'node_modules/selenium-webdriver': { version: '4.47.0' },
      'node_modules/mocha': { version: '11.8.0' },
    },
  });
  writeFile(root, '.github/workflows/ci.yml', 'name: ci\n');
  return root;
}
