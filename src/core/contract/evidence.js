/**
 * Evidence: a first-class product concept, not a logging detail.
 *
 * The GenXEvo principle is *evidence before modification*. An agent should be
 * able to point at the specific observation that justified a code change, and a
 * human reviewing the repair should be able to check it. That only works if
 * every observation carries three things: what it is, where it came from, and
 * whether it may be believed as an instruction.
 *
 * The last of those is the trust boundary made explicit in the data model.
 * Without a level in the data itself, "the project said X" and "your operator
 * said X" arrive looking identical.
 */

import { EVIDENCE_KIND_VALUES, TRUST_LEVEL_VALUES } from './vocabularies.js';
import { deepFreeze } from '../support/freeze.js';

/**
 * @typedef {object} Evidence
 * @property {string} id
 * @property {string} kind
 * @property {string} trust
 * @property {string} summary        Written by GenXEvo, so trusted even when the content is not.
 * @property {string} [source]
 * @property {string} [contentType]
 * @property {string} [content]
 * @property {string} [artifactPath] Workspace-relative. Never absolute.
 * @property {boolean} truncated     An agent must not conclude anything from an absence
 *                                   that was merely cut off.
 * @property {string} capturedAt
 */

/**
 * @param {object} spec
 * @returns {Evidence}
 */
export function evidence({
  id,
  kind,
  trust,
  summary,
  source,
  contentType,
  content,
  artifactPath,
  truncated = false,
  capturedAt,
}) {
  if (!EVIDENCE_KIND_VALUES.includes(kind)) {
    throw new TypeError(`'${kind}' is not a published evidence kind.`);
  }
  if (!TRUST_LEVEL_VALUES.includes(trust)) {
    throw new TypeError(`Evidence requires an explicit trust level; got '${trust}'.`);
  }

  const item = { id, kind, trust, summary };
  if (source !== undefined && source !== null) item.source = source;
  if (contentType !== undefined && contentType !== null) item.contentType = contentType;
  if (content !== undefined && content !== null) item.content = content;
  if (artifactPath !== undefined && artifactPath !== null) item.artifactPath = artifactPath;
  item.truncated = Boolean(truncated);
  item.capturedAt =
    capturedAt instanceof Date ? isoUtc(capturedAt) : (capturedAt ?? isoUtc(new Date()));
  return deepFreeze(item);
}

/**
 * Render an instant as ISO-8601 in UTC with a `Z` suffix.
 *
 * @param {Date} moment
 * @returns {string}
 */
export function isoUtc(moment) {
  return moment.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
