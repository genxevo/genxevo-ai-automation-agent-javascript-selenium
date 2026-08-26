/**
 * The evidence vocabulary discovery matches against, and the rules for reading
 * it WITHOUT EXECUTING ANYTHING.
 *
 * This is the JavaScript form of Python's ADR-016, and its blast radius is
 * larger. In .NET a project file is inert XML. In Python, `setup.py` and
 * `conftest.py` are programs. In JAVASCRIPT THE NORMAL CASE IS THAT
 * CONFIGURATION IS A PROGRAM: `wdio.conf.js`, `playwright.config.js`,
 * `jest.config.js`, `vitest.config.ts`, `.mocharc.js`, `eslint.config.mjs` and
 * `.pnpmfile.cjs` are all executable, and `package.json`'s `scripts` and
 * lifecycle hooks are shell command lines.
 *
 * So: config files are READ AS TEXT and pattern-matched; nothing is `import`ed,
 * `require`d or evaluated; `npm install` is never run, because `preinstall` and
 * `postinstall` are arbitrary code from a repository the agent was merely asked
 * to LOOK at.
 *
 * Import detection uses a REGULAR EXPRESSION rather than a parser, and that is a
 * deliberate re-derivation of Python's reasoning rather than a shortcut. This
 * runs over every candidate module in a workspace and only ever needs the
 * specifier. A parser is also strictly LESS robust here: a JavaScript workspace
 * routinely mixes JSX, TypeScript and syntax targeting a different runtime, all
 * of which raise on a parser and all of which still yield usable import evidence
 * to a regex.
 */

/** Lockfile name -> package manager. The strongest single signal. */
export const LOCKFILES = Object.freeze({
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
});

/** Dependency name -> the automation framework it implies. */
export const AUTOMATION_DEPENDENCIES = Object.freeze({
  'selenium-webdriver': 'Selenium',
  'selenium-standalone': 'Selenium',
  webdriverio: 'WebdriverIO',
  '@wdio/cli': 'WebdriverIO',
  '@playwright/test': 'Playwright',
  playwright: 'Playwright',
  'playwright-core': 'Playwright',
  puppeteer: 'Puppeteer',
  'puppeteer-core': 'Puppeteer',
  'appium-webdriver': 'Appium',
  appium: 'Appium',
});

/** Import specifier root -> the automation framework it implies. */
export const AUTOMATION_IMPORTS = Object.freeze({
  'selenium-webdriver': 'Selenium',
  webdriverio: 'WebdriverIO',
  '@wdio/globals': 'WebdriverIO',
  '@playwright/test': 'Playwright',
  playwright: 'Playwright',
  puppeteer: 'Puppeteer',
});

/** Dependency name -> the test runner it implies. */
export const RUNNER_DEPENDENCIES = Object.freeze({
  mocha: 'mocha',
  jest: 'jest',
  'jest-cli': 'jest',
  vitest: 'vitest',
  '@wdio/cli': 'wdio',
  '@wdio/mocha-framework': 'wdio',
  '@wdio/jasmine-framework': 'wdio',
});

/** Configuration file name (lowercased) -> the runner it belongs to. */
export const RUNNER_CONFIG_FILES = Object.freeze({
  '.mocharc.json': 'mocha',
  '.mocharc.jsonc': 'mocha',
  '.mocharc.yml': 'mocha',
  '.mocharc.yaml': 'mocha',
  '.mocharc.js': 'mocha',
  '.mocharc.cjs': 'mocha',
  'jest.config.js': 'jest',
  'jest.config.cjs': 'jest',
  'jest.config.mjs': 'jest',
  'jest.config.json': 'jest',
  'jest.config.ts': 'jest',
  'vitest.config.js': 'vitest',
  'vitest.config.mjs': 'vitest',
  'vitest.config.ts': 'vitest',
  'vitest.workspace.ts': 'vitest',
  'wdio.conf.js': 'wdio',
  'wdio.conf.cjs': 'wdio',
  'wdio.conf.mjs': 'wdio',
  'wdio.conf.ts': 'wdio',
});

/**
 * Files that pin a Node version, and how much they should be trusted.
 * `.nvmrc` and `.node-version` are exact pins; `engines` is a range.
 */
export const NODE_PIN_FILES = Object.freeze(['.nvmrc', '.node-version']);

/** Packages worth reading out of `node_modules` to learn what is INSTALLED. */
export const NOTABLE_INSTALLED_PACKAGES = Object.freeze([
  'selenium-webdriver',
  'webdriverio',
  '@wdio/cli',
  '@playwright/test',
  'playwright',
  'puppeteer',
  'mocha',
  'jest',
  'vitest',
  'chromedriver',
  'geckodriver',
  'edgedriver',
]);

/** Default test-file shapes, used ONLY when the project declares nothing else. */
export const DEFAULT_TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/i;

/** Data files that make a directory look like test data when no code is present. */
export const TEST_DATA_EXTENSIONS = Object.freeze(
  new Set(['.json', '.csv', '.yaml', '.yml', '.xlsx', '.xml', '.txt']),
);

/** CI configuration filenames outside `.github/workflows`. */
export const CI_FILE_NAMES = Object.freeze(
  new Set(['azure-pipelines.yml', 'azure-pipelines.yaml', '.gitlab-ci.yml', 'jenkinsfile']),
);

/**
 * Import and require specifiers, without executing anything.
 *
 * THREE SIMPLE PATTERNS RATHER THAN ONE CLEVER ONE, and that is a bug fix rather
 * than a style preference. A single alternation with a lazy `[\s\S]{0,256}?`
 * bridging an `import` keyword to its `from` keyword will happily span SEVERAL
 * LINES: given a file whose dynamic `import('a')` is followed a line later by
 * `import b from 'c'`, it matches from the first `import` to the second `from`,
 * captures `c`, and swallows `a` entirely. Two of this repository's own fixture
 * imports vanished that way before the test caught it.
 *
 * Each pattern below is unambiguous, anchored on a delimiter that cannot repeat,
 * and bounded - which matters twice over, because JavaScript regular expressions
 * cannot be timed out (see `security/redaction.js`) and this runs over untrusted
 * source.
 */
const SPECIFIER = '[\'"]([^\'"\\n]{1,256})[\'"]';

const IMPORT_PATTERNS = Object.freeze([
  // import x from 'y' / export { a } from 'y' - any layout, including multi-line.
  new RegExp(`\\bfrom\\s{0,8}${SPECIFIER}`, 'g'),
  // require('y') / await import('y')
  new RegExp(`\\b(?:require|import)\\s{0,4}\\(\\s{0,4}${SPECIFIER}`, 'g'),
  // import 'y' - a side-effect-only import.
  new RegExp(`\\bimport\\s{1,4}${SPECIFIER}`, 'g'),
]);

/**
 * Return the package specifiers a source file imports, reduced to their package
 * root (`selenium-webdriver/lib/by` -> `selenium-webdriver`, `@wdio/cli/x` ->
 * `@wdio/cli`). Relative and `node:` specifiers are ignored.
 *
 * @param {string} source
 * @returns {Set<string>}
 */
export function importedPackages(source) {
  const roots = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1];
      if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) continue;
      if (specifier.startsWith('node:')) continue;
      const parts = specifier.split('/');
      roots.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
    }
  }
  return roots;
}
