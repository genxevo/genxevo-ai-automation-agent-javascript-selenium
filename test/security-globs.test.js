import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HAS_NATIVE_MATCHER,
  firstMatchingGlob,
  matchesGlob,
  translate,
} from '../src/core/security/globs.js';

/**
 * THE ACCEPTANCE TABLE.
 *
 * This table was written and measured BEFORE the implementation was chosen. Both
 * sibling products hand-write a glob translator because their platforms cannot
 * tell `*` from `**`. Node's `path.matchesGlob` can - including the case that
 * decides whether the deny-list protects a `.env` at the workspace root - so the
 * builtin is used and less code ships.
 *
 * The last two rows are the load-bearing ones. The Java review records that the
 * JDK's matcher does NOT match the zero-directory case, so a Java port would
 * have to expand every pattern. Node does match it, which was verified rather
 * than assumed.
 */
const TABLE = [
  ['a.txt', '*.txt', true, 'a single star matches within one segment'],
  ['d/a.txt', '*.txt', false, 'a single star NEVER crosses a separator'],
  ['d/a.txt', '**/*.txt', true, 'a double star crosses separators'],
  ['d/e/a.txt', '**/*.txt', true, 'and any number of them'],
  ['a.txt', '**/*.txt', true, 'ZERO directories - the load-bearing case'],
  ['.env', '**/.env', true, 'a deny-list entry protects the workspace ROOT'],
  ['packages/app/.env', '**/.env', true, 'and every depth below it'],
  ['.env.production', '**/.env.*', true, 'suffixed variants'],
  ['.envrc', '**/.env', false, 'and nothing merely similar'],
  ['a.txt', 'a?txt', true, 'a question mark matches any single character, a dot included'],
  ['axtxt', 'a?txt', true, 'a question mark matches exactly one'],
  ['abctxt', 'a?txt', false, 'and never more than one'],
  ['d/axt', 'a?t', false, 'a question mark never crosses a separator'],
  ['certs/server.key', '**/*.key', true, 'key material at any depth'],
  ['node_modules/x/.npmrc', '**/.npmrc', true, 'including inside a dependency tree'],
];

test('the acceptance table holds for the matcher actually in use', () => {
  for (const [candidate, pattern, expected, why] of TABLE) {
    assert.equal(matchesGlob(candidate, pattern), expected, `${candidate} vs ${pattern} — ${why}`);
  }
});

test('the builtin and the fallback translator AGREE on every row', () => {
  // A security control must not change behaviour if an experimental API is
  // withdrawn. Asserting both implementations against one table is a stronger
  // guarantee than trusting either.
  for (const [candidate, pattern, expected] of TABLE) {
    assert.equal(
      matchesGlob(candidate, pattern, { forceFallback: true }),
      expected,
      `fallback: ${candidate} vs ${pattern}`,
    );
  }
});

test('the builtin matcher is present on the supported floor', () => {
  assert.equal(HAS_NATIVE_MATCHER, true);
});

test('a pattern means the same thing with either separator', () => {
  assert.equal(matchesGlob('packages\\app\\.env', '**/.env'), true);
  assert.equal(matchesGlob('packages/app/.env', '**\\.env'), true);
});

test('pattern text is NEVER interpreted as a regular expression', () => {
  // An operator writing `**/*.key` in a deny-list must not accidentally be
  // writing a regex.
  assert.equal(matchesGlob('aXb', 'a.b', { forceFallback: true }), false);
  assert.equal(matchesGlob('a.b', 'a.b', { forceFallback: true }), true);
  assert.equal(matchesGlob('aaa', 'a+', { forceFallback: true }), false);
  assert.equal(matchesGlob('a+', 'a+', { forceFallback: true }), true);
  assert.ok(translate('a.b').includes('a\\.b'));
});

test('case sensitivity is the caller decision, because the platform decides it', () => {
  assert.equal(matchesGlob('.ENV', '**/.env', { caseSensitive: true }), false);
  assert.equal(matchesGlob('.ENV', '**/.env', { caseSensitive: false }), true);
});

test('firstMatchingGlob returns the pattern, so a refusal can name it', () => {
  assert.equal(firstMatchingGlob('a/.env', ['**/*.key', '**/.env']), '**/.env');
  assert.equal(firstMatchingGlob('a/b.js', ['**/*.key', '**/.env']), null);
  assert.equal(firstMatchingGlob('a/b.js', []), null);
});

test('an empty pattern never matches', () => {
  assert.equal(matchesGlob('anything', ''), false);
  assert.equal(matchesGlob('anything', null), false);
});
