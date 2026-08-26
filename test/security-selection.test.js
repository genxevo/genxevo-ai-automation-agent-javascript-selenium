import test from 'node:test';
import assert from 'node:assert/strict';

import { POTENT_FLAGS, SelectionKind, validateSelection } from '../src/core/security/selection.js';
import { ErrorCode } from '../src/core/contract/errorCodes.js';
import { WarningCode } from '../src/core/contract/warningCodes.js';
import { boundaryFor, tempWorkspace, writeFile } from './helpers/fixtures.js';

function project() {
  const root = tempWorkspace();
  writeFile(root, 'test/login.test.js', '');
  writeFile(root, 'test/checkout.spec.mjs', '');
  return { root, boundary: boundaryFor(root) };
}

/**
 * THE ARGUMENT-INJECTION CROSS-PRODUCT.
 *
 * Every potent flag, against every selection kind. In JavaScript this list is
 * richer than pytest's: `--require` loads an arbitrary module into mocha,
 * `--setupFiles` and `--globalSetup` do the same for jest, `--config` points
 * every runner at an arbitrary JS file, and `--import`/`--loader` register a
 * module hook in Node itself.
 */
const HOSTILE_FLAGS = [
  '--require=/tmp/evil.js',
  '-r',
  '-r /tmp/evil.js',
  '--config=/tmp/evil.config.js',
  '-c /tmp/evil.js',
  '--setupFiles=/tmp/evil.js',
  '--globalSetup=/tmp/evil.js',
  '--import=/tmp/evil.js',
  '--loader=/tmp/evil.mjs',
  '--reporter=/tmp/evil.js',
  '--experimental-loader=/tmp/evil.mjs',
];

test('EVERY potent flag is refused, for EVERY selection kind', () => {
  const { boundary } = project();
  for (const kind of Object.values(SelectionKind)) {
    for (const flag of HOSTILE_FLAGS) {
      const result = validateSelection(kind, flag, { boundary });
      assert.equal(result.valid, false, `${kind} / ${flag}`);
      assert.equal(result.error.code, ErrorCode.SELECTION_REJECTED, `${kind} / ${flag}`);
    }
  }
});

test('the refusal NAMES the flags, so an agent learns why rather than merely that', () => {
  const { boundary } = project();
  const refusal = validateSelection(SelectionKind.FILE_PATH, '--require=/tmp/x.js', { boundary });
  assert.match(refusal.error.remediation, /--require/);
  assert.ok(POTENT_FLAGS.includes('--require'));
});

test('shell metacharacters are refused even though no shell is ever invoked', () => {
  // Two layers protect the boundary and both are required: this validator, and
  // an argument ARRAY at the process boundary. Neither alone is sufficient.
  const { boundary } = project();
  for (const hostile of [
    'test/login.test.js; rm -rf /',
    'test/login.test.js && curl evil.example.test',
    'test/login.test.js | tee /tmp/x',
    '$(id)',
    '`id`',
    'test/login.test.js"',
    "test/login.test.js'",
  ]) {
    const result = validateSelection(SelectionKind.FILE_PATH, hostile, { boundary });
    assert.equal(result.valid, false, hostile);
  }
});

test('a control character is refused', () => {
  // Built from code points rather than written literally, so this source file
  // contains none of the bytes it exists to refuse.
  const { boundary } = project();
  const base = 'test/login.test.js';
  for (const code of [0x00, 0x07, 0x09, 0x0a, 0x0d, 0x1b, 0x7f]) {
    const hostile = `${base}${String.fromCharCode(code)}malicious`;
    const result = validateSelection(SelectionKind.FILE_PATH, hostile, { boundary });
    assert.equal(result.valid, false, `code point ${code}`);
  }
});

test('a node-path selection is routed through the SAME PathBoundary', () => {
  // The boundary's own refusal is returned VERBATIM, so the agent sees one error
  // code for every path refusal in the product.
  const { boundary } = project();
  const traversal = validateSelection(SelectionKind.FILE_PATH, '../../etc/passwd', { boundary });
  assert.equal(traversal.valid, false);
  assert.equal(traversal.error.code, ErrorCode.PATH_OUTSIDE_WORKSPACE);

  const root = tempWorkspace();
  writeFile(root, '.npmrc', 'x');
  const denied = validateSelection(SelectionKind.FILE_PATH, '.npmrc', {
    boundary: boundaryFor(root),
  });
  assert.equal(denied.error.code, ErrorCode.PATH_DENIED);
});

test('a legitimate file-path selection is accepted', () => {
  const { boundary } = project();
  for (const selection of ['test/login.test.js', 'test/checkout.spec.mjs']) {
    const result = validateSelection(SelectionKind.FILE_PATH, selection, { boundary });
    assert.equal(result.valid, true, selection);
    assert.equal(result.warnings.length, 0, selection);
    assert.equal(result.selection.relativePath, selection);
  }
});

test('a directory selection is accepted but WARNED about', () => {
  const { boundary } = project();
  const result = validateSelection(SelectionKind.FILE_PATH, 'test', { boundary });
  assert.equal(result.valid, true);
  assert.equal(result.warnings[0].code, WarningCode.SELECTION_WHOLE_FILE);
});

test('a test-name selection is a LITERAL substring, never a regex', () => {
  // mocha --grep and jest -t treat their argument as a regular expression, so a
  // model-supplied pattern is both a selection surprise and, because JavaScript
  // regexes cannot be timed out, a way to hang the runner.
  for (const pattern of ['.*', 'a|b', '^login$', 'a{1,9999}', '(a+)+b', 'a\\d', '[a-z]+']) {
    const result = validateSelection(SelectionKind.TEST_NAME, pattern);
    assert.equal(result.valid, false, pattern);
    assert.match(result.error.remediation, /REGULAR EXPRESSION/);
  }
});

test('a legitimate test name is accepted', () => {
  const result = validateSelection(SelectionKind.TEST_NAME, 'logs in with valid credentials');
  assert.equal(result.valid, true);
  assert.equal(result.warnings.length, 0);
});

test('a very short test name is accepted but WARNED about', () => {
  const result = validateSelection(SelectionKind.TEST_NAME, 'log');
  assert.equal(result.valid, true);
  assert.equal(result.warnings[0].code, WarningCode.SELECTION_VERY_BROAD);
});

test('an empty selection is refused when one is required, and allowed when not', () => {
  const { boundary } = project();
  const required = validateSelection(SelectionKind.FILE_PATH, '', { boundary });
  assert.equal(required.valid, false);
  assert.match(required.error.remediation, /Running the whole suite/);

  const permitted = validateSelection(SelectionKind.FILE_PATH, '', { boundary, required: false });
  assert.equal(permitted.valid, true);
  assert.equal(permitted.selection, null);
});

test('an over-long selection is refused', () => {
  const { boundary } = project();
  const result = validateSelection(SelectionKind.FILE_PATH, `test/${'a'.repeat(600)}.js`, {
    boundary,
  });
  assert.equal(result.valid, false);
  assert.match(result.error.message, /longer than the permitted/);
});

test('an unrecognised kind is refused and the known kinds are listed', () => {
  const result = validateSelection('nodeId', 'x');
  assert.equal(result.valid, false);
  assert.match(result.error.remediation, /'filePath'/);
});

test('a file-path selection without a boundary is refused rather than trusted', () => {
  const result = validateSelection(SelectionKind.FILE_PATH, 'test/login.test.js');
  assert.equal(result.valid, false);
  assert.match(result.error.message, /no workspace boundary/);
});

test('the default kind is a file path, because that is what every JS runner takes', () => {
  const { boundary } = project();
  const result = validateSelection(null, 'test/login.test.js', { boundary });
  assert.equal(result.valid, true);
  assert.equal(result.selection.kind, SelectionKind.FILE_PATH);
});
