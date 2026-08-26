/**
 * The random component of run identifiers.
 *
 * `crypto.randomBytes`, never `Math.random()`. A predictable run identifier
 * would let anything able to write inside the workspace pre-create or clobber a
 * run directory, and correlation would stop being trustworthy — which is the
 * one property the run model exists to provide.
 */

import { randomBytes } from 'node:crypto';

/** @typedef {{ nextToken(length?: number): string }} TokenSource */

/** @type {TokenSource} */
export const SECURE_TOKENS = Object.freeze({
  nextToken(length = 6) {
    if (!Number.isInteger(length) || length < 1 || length > 32) {
      throw new RangeError('Token length must be an integer between 1 and 32.');
    }
    return randomBytes(Math.ceil(length / 2))
      .toString('hex')
      .slice(0, length);
  },
});

/**
 * A token source that always returns the same value, for tests.
 *
 * @param {string} token
 * @returns {TokenSource}
 */
export function fixedTokens(token) {
  return Object.freeze({
    nextToken() {
      return token;
    },
  });
}
