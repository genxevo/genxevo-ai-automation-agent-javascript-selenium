/**
 * Validating a model-supplied test selection before it reaches a test runner.
 *
 * This is the JavaScript counterpart of the C# sibling's `TestFilterValidator`
 * and the Python sibling's `selection` module, and it is a translation of
 * NEITHER. The VSTest filter grammar does not exist here; neither does the
 * pytest node-ID grammar; and neither does the threat each was built against.
 *
 * WHAT THREATENS A JAVASCRIPT RUNNER
 * ----------------------------------
 * 1. ARGUMENT INJECTION, and the flag list is richer than pytest's. Every
 *    JavaScript runner has at least one flag that loads and executes an
 *    arbitrary module:
 *
 *      --require / -r        mocha: loads any module before the suite
 *      --config / -c         every runner: points at an arbitrary JS file
 *      --setupFiles          jest: runs arbitrary modules per test file
 *      --globalSetup         jest / playwright: runs an arbitrary module once
 *      --import / --loader   node: registers an arbitrary module hook
 *      --reporter            several runners resolve a reporter by module path
 *
 *    So ANY selection beginning with `-` is refused outright, for every kind,
 *    before kind dispatch. That is the single most important rule in this
 *    module, and the runner is required to pass selections after `--`.
 *
 *    `NODE_OPTIONS` deserves its own sentence: it can inject `--require` into
 *    EVERY child process, so the phase-1D executor strips it from the child
 *    environment rather than validating around it.
 *
 * 2. PATH TRAVERSAL THROUGH A SELECTOR, and it is more central here than in
 *    either sibling, because every JavaScript runner's primary selector IS a
 *    file path. The path is resolved through the SAME `PathBoundary` that
 *    governs every other file access, and the boundary's own refusal is returned
 *    VERBATIM, so the agent sees one error code for every path refusal in the
 *    product.
 *
 * 3. A SECOND INJECTION SURFACE THE SIBLINGS DO NOT HAVE. Mocha's `--grep` and
 *    Jest's `-t` treat their argument as a REGULAR EXPRESSION. A model-supplied
 *    pattern is therefore both a denial-of-service vector (JavaScript has no
 *    regex timeout - see `redaction.js`) and a way to select far more than
 *    intended. So a `testName` selection is accepted as a LITERAL SUBSTRING
 *    only: regex metacharacters are refused rather than escaped, because
 *    escaping quietly changes what the agent asked for.
 *
 * 4. AN UNBOUNDED RUN. Easier to trigger here than in either sibling, because an
 *    empty selection means "the whole suite" in every JavaScript runner.
 *    Accepted only when the operator has allowed it, and warned about, never
 *    silently permitted.
 *
 * AS IN BOTH SIBLINGS, TWO LAYERS PROTECT THE BOUNDARY AND BOTH ARE REQUIRED:
 * this validator, and an argument ARRAY at the process boundary with no shell.
 * Neither alone is sufficient.
 */

import { ErrorCategory } from '../contract/vocabularies.js';
import { ErrorCode } from '../contract/errorCodes.js';
import { WarningCode } from '../contract/warningCodes.js';
import { agentError, truncate } from '../contract/agentError.js';
import { resultWarning } from '../contract/toolResult.js';
import { PathIntent } from './pathBoundary.js';
import { deepFreeze } from '../support/freeze.js';

export const DEFAULT_MAX_SELECTION_LENGTH = 512;

/** How a caller is naming the tests it wants to run. */
export const SelectionKind = Object.freeze({
  /** A workspace-relative test file or directory: `test/login.test.js`. */
  FILE_PATH: 'filePath',
  /** A literal substring of a test's name, for `--grep` / `-t`. Never a regex. */
  TEST_NAME: 'testName',
});

export const SELECTION_KIND_VALUES = Object.freeze(Object.values(SelectionKind));

/**
 * Flags named in the refusal message, so an agent that trips the rule learns why
 * rather than merely that.
 */
export const POTENT_FLAGS = Object.freeze([
  '--require',
  '-r',
  '--config',
  '-c',
  '--setupFiles',
  '--globalSetup',
  '--import',
  '--loader',
  '--reporter',
]);

/** A literal test-name substring. Deliberately narrow; every regex metacharacter is absent. */
const TEST_NAME_ALLOWED = /^[A-Za-z0-9 _\-#/:,']+$/;

/** Path characters a selection may use. No globs - those arrive with the runner in phase 1D. */
const FILE_PATH_ALLOWED = /^[A-Za-z0-9 _\-./@]+$/;

/**
 * True when the text contains a C0 control character or DEL.
 *
 * Written as a code-point comparison rather than a regular expression on
 * purpose: a regex literal for this range would mean this source file has to
 * CONTAIN the bytes it exists to refuse, which makes the file hazardous to
 * edit and easy to corrupt in transit. The check is also cheaper.
 *
 * @param {string} text
 * @returns {boolean}
 */
function hasControlCharacter(text) {
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** File extensions a JavaScript or TypeScript test file may carry. */
const TEST_FILE_EXTENSION = /\.[cm]?[jt]sx?$/;

/**
 * Validate a test selection.
 *
 * @param {string | null | undefined} kind
 * @param {string | null | undefined} value
 * @param {object} [options]
 * @param {import('./pathBoundary.js').PathBoundary} [options.boundary] Required for `filePath`.
 * @param {boolean} [options.required] When true, an empty selection is refused.
 * @param {number} [options.maxLength]
 */
export function validateSelection(
  kind,
  value,
  { boundary, required = true, maxLength = DEFAULT_MAX_SELECTION_LENGTH } = {},
) {
  const resolvedKind = kind === null || kind === undefined ? SelectionKind.FILE_PATH : String(kind);
  if (!SELECTION_KIND_VALUES.includes(resolvedKind)) {
    return reject(
      `'${kind}' is not a recognised selection kind.`,
      `Use one of: ${SELECTION_KIND_VALUES.map((k) => `'${k}'`).join(', ')}.`,
    );
  }

  const text = (value ?? '').trim();

  if (text.length === 0) {
    if (required) {
      return reject(
        'A test selection is required.',
        "Supply a selection that names one test file or one test, for example 'test/login.test.js'. Running the whole suite through the agent is disabled by configuration.",
      );
    }
    return deepFreeze({ valid: true, selection: null, warnings: [] });
  }

  if (text.length > maxLength) {
    return reject(
      `The selection is longer than the permitted ${maxLength} characters.`,
      'Shorten it; a selection this long usually means several were concatenated.',
    );
  }

  if (hasControlCharacter(text)) {
    return reject(
      'The selection contained a control character.',
      'Remove newlines, tabs and control characters from the selection.',
    );
  }

  if (text.startsWith('-')) {
    return reject(
      'The selection starts with a dash, so a test runner would read it as a command-line flag.',
      `Selections never begin with '-'. Flags such as ${POTENT_FLAGS.slice(0, 4).join(', ')} load and execute arbitrary modules inside the runner, so this is refused for every selection kind. If you meant a test-name substring, pass kind='testName' and the substring alone.`,
      `selection='${truncate(text, 120)}'`,
    );
  }

  return resolvedKind === SelectionKind.FILE_PATH
    ? validateFilePath(text, boundary)
    : validateTestName(text);
}

function validateFilePath(text, boundary) {
  if (!boundary) {
    return reject(
      'A file-path selection cannot be validated because no workspace boundary is configured.',
      'Start the agent with --workspace pointing at the automation project.',
    );
  }

  if (!FILE_PATH_ALLOWED.test(text)) {
    const offending = [...new Set([...text].filter((c) => !FILE_PATH_ALLOWED.test(c)))].slice(0, 5);
    return reject(
      'The file-path selection contains characters that are not part of a workspace-relative path.',
      'Use only letters, digits, spaces and the characters _ - . / @. Shell metacharacters, quotes and glob characters are never accepted.',
      `offending characters: ${offending.map((c) => `'${c}'`).join(' ')}`,
    );
  }

  const resolved = boundary.resolve(text, PathIntent.READ);
  if (!resolved.ok) {
    // The boundary's own refusal is returned VERBATIM rather than rewritten, so
    // the agent sees one consistent vocabulary for every path refusal in the
    // product. Copying this subtlety from Python's ADR-015 exactly.
    return deepFreeze({ valid: false, error: resolved.error, warnings: [] });
  }

  const warnings = [];
  if (!TEST_FILE_EXTENSION.test(resolved.path.relativePath)) {
    warnings.push(
      resultWarning(
        WarningCode.SELECTION_WHOLE_FILE,
        'This selection names a directory rather than a single test file, so every test beneath it will run.',
        'Name a single test file, and add a testName selection, to run one test.',
      ),
    );
  }

  return deepFreeze({
    valid: true,
    selection: {
      kind: SelectionKind.FILE_PATH,
      value: text,
      relativePath: resolved.path.relativePath,
    },
    warnings,
  });
}

function validateTestName(text) {
  if (!TEST_NAME_ALLOWED.test(text)) {
    const offending = [...new Set([...text].filter((c) => !TEST_NAME_ALLOWED.test(c)))].slice(0, 5);
    return reject(
      'The test-name selection contains characters that are not part of a literal test name.',
      "Mocha's --grep and Jest's -t treat their argument as a REGULAR EXPRESSION, so a pattern would both change what is selected and, because JavaScript regular expressions cannot be timed out, risk hanging the runner. Supply a literal substring using only letters, digits, spaces and _ - # / : , '.",
      `offending characters: ${offending.map((c) => `'${c}'`).join(' ')}`,
    );
  }

  const warnings = [];
  if (text.replace(/\s/g, '').length <= 4) {
    warnings.push(
      resultWarning(
        WarningCode.SELECTION_VERY_BROAD,
        `'${text}' is a short substring, and it is matched against every collected test name, so the run is likely to be very broad.`,
        'Prefer a file path, or a longer and more specific name.',
      ),
    );
  }

  return deepFreeze({
    valid: true,
    selection: { kind: SelectionKind.TEST_NAME, value: text },
    warnings,
  });
}

function reject(message, remediation, detail) {
  return deepFreeze({
    valid: false,
    error: agentError({
      code: ErrorCode.SELECTION_REJECTED,
      category: ErrorCategory.SECURITY,
      message,
      remediation,
      detail,
    }),
    warnings: [],
  });
}
