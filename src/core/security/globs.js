/**
 * Glob matching for the security deny-list.
 *
 * Both sibling products hand-write a glob-to-regex translator, because Python's
 * `fnmatch` cannot tell `*` from `**` and .NET has no built-in that can either.
 * Node CAN: `path.matchesGlob` distinguishes them correctly and — this is the
 * load-bearing part — matches the zero-directory case, so `**' + '/.env` matches a
 * bare `.env` at the workspace root. That was measured against the acceptance
 * table in `test/security-globs.test.js` before this module was written.
 *
 * So why is there still a translator below? Because `path.matchesGlob` is marked
 * experimental, and this is a SECURITY control: the deny-list is what stops a
 * credential file being read. An experimental API that is removed or changes
 * semantics would silently widen the hole rather than fail loudly. The builtin
 * is used when present; the translator is the fallback; and the test asserts
 * that BOTH produce identical verdicts across the whole acceptance table, which
 * is a stronger guarantee than either alone.
 *
 * Supported syntax, and nothing else:
 *   `*`    any run of characters except a separator
 *   `**`   any run of characters including separators
 *   `**' + '/`  also matches zero directories, so `a/**' + '/b` matches `a/b`
 *   `?`    exactly one character except a separator
 *
 * Matching is always performed against a path normalised to forward slashes, so
 * a pattern in a shared configuration file means the same thing on a
 * contributor's Mac and in Windows CI.
 */

import path from 'node:path';

/** Whether the runtime offers the builtin matcher. */
export const HAS_NATIVE_MATCHER = typeof path.matchesGlob === 'function';

const CACHE = new Map();

/**
 * @param {string} candidate  A relative path.
 * @param {string} pattern
 * @param {object} [options]
 * @param {boolean} [options.caseSensitive]
 * @param {boolean} [options.forceFallback] Test-only: exercise the translator.
 * @returns {boolean}
 */
export function matchesGlob(
  candidate,
  pattern,
  { caseSensitive = true, forceFallback = false } = {},
) {
  if (typeof pattern !== 'string' || pattern.length === 0) return false;

  let subject = normalise(candidate);
  let expression = normalise(pattern);
  if (!caseSensitive) {
    subject = subject.toLowerCase();
    expression = expression.toLowerCase();
  }

  if (HAS_NATIVE_MATCHER && !forceFallback) {
    return path.matchesGlob(subject, expression);
  }
  return compile(expression).test(subject);
}

/**
 * The first pattern that matches, or null. Returned rather than a boolean so a
 * refusal can name the pattern and an operator knows what to change.
 *
 * @param {string} candidate
 * @param {Iterable<string>} patterns
 * @param {object} [options]
 * @returns {string | null}
 */
export function firstMatchingGlob(candidate, patterns, options) {
  for (const pattern of patterns) {
    if (matchesGlob(candidate, pattern, options)) return pattern;
  }
  return null;
}

function normalise(value) {
  return String(value).replaceAll('\\', '/');
}

function compile(pattern) {
  const cached = CACHE.get(pattern);
  if (cached) return cached;
  const compiled = new RegExp(translate(pattern));
  CACHE.set(pattern, compiled);
  return compiled;
}

/**
 * Translate a glob into an anchored regular expression.
 *
 * Every literal character is escaped, so pattern text is never interpreted as a
 * regular expression. An operator writing `**' + '/*.key` in a deny-list must not
 * accidentally be writing a regex.
 */
export function translate(pattern) {
  const out = ['^'];
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        out.push('(?:.*/)?');
        index += 3;
      } else {
        out.push('.*');
        index += 2;
      }
    } else if (character === '*') {
      out.push('[^/]*');
      index += 1;
    } else if (character === '?') {
      out.push('[^/]');
      index += 1;
    } else {
      out.push(character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      index += 1;
    }
  }
  out.push('$');
  return out.join('');
}
