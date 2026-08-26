/**
 * ESLint flat configuration.
 *
 * THE RULES ARE LISTED EXPLICITLY AND NO SHARED PRESET IS EXTENDED. That is a
 * decision, not laziness. `@eslint/js` would add a devDependency whose contents
 * change between minor releases, which means a routine `npm update` could start
 * failing this repository's build for reasons nobody chose. Every rule below is
 * a CORE rule, needs no plugin, and is here because it protects something this
 * product actually claims:
 *
 *   no-console          stdout belongs to the JSON-RPC transport. This is layer
 *                       two of three; see the note in `src/mcp/main.js`.
 *   no-eval, no-new-func, no-implied-eval
 *                       GenXEvo NEVER evaluates anything from the automation
 *                       project. `wdio.conf.js` and its kind are read as text.
 *   no-restricted-syntax
 *                       `child_process` is not imported ANYWHERE in this build.
 *                       Execution arrives in phase 1D, behind a validated
 *                       selection and an argument array; until then the absence
 *                       is enforced rather than promised.
 *   require-atomic-updates, no-unmodified-loop-condition, no-await-in-loop
 *                       The scan is async and cancellable; these are the shapes
 *                       that make an AbortSignal silently ineffective.
 *
 * `globals` is likewise declared by hand: the handful of runtime globals this
 * product touches is short enough to read, and a reader can see exactly what
 * ambient surface the code assumes.
 */

const nodeGlobals = {
  process: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
  performance: 'readonly',
  structuredClone: 'readonly',
  console: 'readonly',
};

export default [
  {
    ignores: ['node_modules/**', 'coverage/**', '.genxevo/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // -- correctness -----------------------------------------------------
      'no-undef': 'error',
      // `_`-prefixed names are the deliberate discard: an unused signal
      // parameter kept for signature uniformity, or a destructured key removed
      // from a comparison. Silent when prefixed, loud otherwise.
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-duplicate-case': 'error',
      'no-fallthrough': 'error',
      'no-unreachable': 'error',
      'no-self-compare': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      // -- asynchrony and cancellation --------------------------------------
      'require-atomic-updates': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-async-promise-executor': 'error',
      'no-promise-executor-return': 'error',

      // -- the product's own promises ---------------------------------------
      'no-console': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportDeclaration[source.value=/^(node:)?child_process$/]:not([source.value='node:child_process'][parent.type='Program'][parent.body])",
          message:
            'This build starts no process. Test execution arrives in phase 1D, behind a validated selection and an argument array with no shell.',
        },
        {
          selector: "CallExpression[callee.name='require']",
          message: 'This package is ESM. Use an import.',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: '__dirname', message: 'ESM: use import.meta.dirname.' },
        { name: '__filename', message: 'ESM: use import.meta.filename.' },
      ],

      // -- clarity -----------------------------------------------------------
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': ['error', 'properties'],
      'no-lonely-if': 'error',
      'no-else-return': ['error', { allowElseIf: false }],
    },
  },
  {
    // Tests spawn the server on purpose; that is the point of them.
    files: ['test/**/*.js'],
    rules: {
      'no-restricted-syntax': 'off',
      'no-console': 'error',
    },
  },
];
