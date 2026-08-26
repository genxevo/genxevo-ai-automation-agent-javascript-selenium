/**
 * Paths refused even inside an approved workspace root.
 *
 * The list is JavaScript-shaped, and the headline entry is `.npmrc`.
 *
 * `.npmrc` is where `//registry.npmjs.org/:_authToken=` lives. Neither the C#
 * nor the Python sibling has an analogue, and its absence would be a real hole
 * rather than a theoretical one: npm's own logs on the machine this product was
 * designed against record FOUR `.npmrc` files, two of them inside project
 * directories that a discovery scan would walk. (None of them was opened. Its
 * being on this list is the reason.)
 *
 * `.pnpmfile.cjs` earns its place twice over: it may contain nothing sensitive,
 * but it is a JavaScript file that pnpm EXECUTES during install, so it belongs
 * in the same category as Python's `setup.py` — recorded as present, never read
 * as configuration, never evaluated.
 *
 * Over-denying costs one operator override. Under-denying costs a credential.
 */

export const DEFAULT_DENIED_FILE_GLOBS = Object.freeze([
  // Package-manager credentials and install hooks. JavaScript-specific and the
  // reason this list is not a copy of either sibling's.
  '**/.npmrc',
  '**/.yarnrc',
  '**/.yarnrc.yml',
  '**/.pnpmfile.cjs',

  // Cross-ecosystem baseline.
  '**/.env',
  '**/.env.*',
  '**/.netrc',
  '**/.ssh/**',
  '**/.aws/**',
  '**/.git/**',

  // Key material.
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.keystore',
  '**/id_rsa*',
  '**/id_ed25519*',

  // Conventional secret files.
  '**/secrets.json',
  '**/*.secrets.json',
  '**/credentials.json',
  '**/.docker/config.json',

  // Deploy tokens.
  '**/.netlify/**',
  '**/.vercel/**',
  '**/.firebase/**',

  // The JavaScript "local override" convention, which is where a developer puts
  // the values they did not want in the committed config.
  '**/*.local.json',
  '**/config.local.*',
]);

/**
 * Directory names no scan descends into.
 *
 * `node_modules` is here, and that is a DIVERGENCE from Python's ADR-017 arrived
 * at by running Python's method rather than copying its answer. Python keeps
 * virtual environments in scope because `pyvenv.cfg` is the only place the
 * interpreter version is written. In JavaScript the declared truth is already in
 * `package.json` and the lockfile — two small files at the root — so walking
 * tens of thousands of files buys nothing.
 *
 * But *declared* is not *installed*, and the gap is real. So discovery reads
 * exactly two things out of `node_modules`, by direct path and never by
 * traversal: `node_modules/.package-lock.json`, and the `package.json` of a
 * bounded allow-list of notable packages. Same principle as ADR-017 — read the
 * cheap authoritative file, decline to walk the expensive tree — opposite
 * answer on the traversal.
 */
export const DEFAULT_IGNORED_DIRECTORIES = Object.freeze([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.nyc_output',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'test-results',
  'playwright-report',
  'blob-report',
  'allure-results',
  'allure-report',
  'junit-report',
  '.idea',
  '.vscode',
  '.vs',
  '.genxevo',
]);
