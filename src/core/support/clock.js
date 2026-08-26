/**
 * The clock, injected.
 *
 * Run identifiers and `startedAt` are part of the published contract, and a
 * contract that cannot be pinned in a test is a contract that drifts. That is a
 * reason, not a habit: it is the only collaborator this product injects, and it
 * is injected for the same reason in all three siblings.
 */

/** @typedef {{ now(): Date }} Clock */

/** @type {Clock} */
export const SYSTEM_CLOCK = Object.freeze({
  now() {
    return new Date();
  },
});

/**
 * A clock pinned to one instant, for tests.
 *
 * @param {string | number | Date} instant
 * @returns {Clock}
 */
export function fixedClock(instant) {
  const moment = instant instanceof Date ? instant : new Date(instant);
  return Object.freeze({
    now() {
      return new Date(moment.getTime());
    },
  });
}
