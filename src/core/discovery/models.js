/**
 * What discovery reports about a JavaScript automation project.
 *
 * Every model here carries its SIGNALS — the specific observations that produced
 * a conclusion — alongside the conclusion itself. That is not decoration. An
 * agent must be able to tell "this is the test directory" from "this is my best
 * guess", and the only honest way to convey the difference is to show the
 * working.
 *
 * All paths are workspace-relative and use forward slashes. An absolute path
 * never leaves the server: it tells the agent, and anything influencing the
 * agent, where the boundary actually sits.
 */

/** How much a conclusion should be trusted. */
export const Confidence = Object.freeze({
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  NONE: 'none',
});

/**
 * The package manager a project actually uses.
 *
 * `unknown` is a real answer. On the machine this product was designed against,
 * four JavaScript projects gave four different answers, and one of them declares
 * `packageManager: "pnpm@9.15.4"` while the installed pnpm is 11.9.0 and
 * Corepack has never run — a declaration the toolchain has silently ignored
 * since the day it was written.
 */
export const PackageManager = Object.freeze({
  NPM: 'npm',
  PNPM: 'pnpm',
  YARN: 'yarn',
  UNKNOWN: 'unknown',
});

/** The test runner a project actually uses. Never silently assumed. */
export const TestRunner = Object.freeze({
  MOCHA: 'mocha',
  JEST: 'jest',
  VITEST: 'vitest',
  NODE: 'node',
  WDIO: 'wdio',
  UNKNOWN: 'unknown',
});

/**
 * The browser automation library in use.
 *
 * WebdriverIO is listed SEPARATELY from Selenium, deliberately. It is a
 * different product with a different API, and conflating the two is exactly how
 * a GenXEvo Selenium agent quietly becomes a WebdriverIO agent that works on
 * nothing.
 */
export const AutomationFramework = Object.freeze({
  SELENIUM: 'Selenium',
  WEBDRIVERIO: 'WebdriverIO',
  PLAYWRIGHT: 'Playwright',
  PUPPETEER: 'Puppeteer',
  APPIUM: 'Appium',
});

/** The module system a project declares. */
export const ModuleSystem = Object.freeze({
  ESM: 'module',
  COMMONJS: 'commonjs',
  UNDECLARED: 'undeclared',
});

/** What a directory appears to hold, established from its contents. */
export const DirectoryKind = Object.freeze({
  TESTS: 'tests',
  PAGE_OBJECTS: 'page-objects',
  TEST_DATA: 'test-data',
  RESULTS: 'results',
  CI: 'ci',
});
