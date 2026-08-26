/**
 * The single door every server-initiated file read goes through.
 *
 * THIS MODULE EXISTS BECAUSE OF A DEFECT BOTH SIBLING PRODUCTS SHIP.
 *
 * In the C# product, verified by searching its own `src/`: `TestFilterValidator`,
 * `UntrustedContent.Wrap`, `ISecretRedactor.Redact` and `IPathBoundary.TryResolve`
 * have ZERO production callers - only `ToRelative` is used. In the Python
 * product it is the same picture: `untrusted.frame()` and
 * `SecretRedactor.redact()` are called from nowhere in `src/`, and
 * `PathBoundary.resolve()` has exactly one production caller which is itself
 * uncalled. Every control is built, fully unit-tested, and wired to nothing.
 *
 * Worse, Python's discovery bypasses its own boundary entirely: it probes every
 * `.py` file directly, while the deny list contains the very filenames that hold
 * Django secrets. The deny-list was true for agent-supplied paths and false for
 * server-initiated reads.
 *
 * The JavaScript product fixes this WITHOUT adding a third tool, by making the
 * read path itself the consumer. `genxevo_discover_project` reads `package.json`
 * and runner configuration through here, so on day one the boundary, the
 * deny-list and the redactor all have a real call site and an end-to-end test.
 *
 * A DENIED FILE IS NOT READ AT ALL - not read and then discarded. The deny-list
 * is a property of every read, not only of the ones an agent asked for.
 */

import fs from 'node:fs';

import { ErrorCategory } from '../contract/vocabularies.js';
import { ErrorCode } from '../contract/errorCodes.js';
import { agentError } from '../contract/agentError.js';
import { PathIntent } from './pathBoundary.js';

/** Default cap for a single read. Larger files are truncated and flagged. */
export const DEFAULT_MAX_READ_BYTES = 65_536;

/**
 * Read a file, bounded and redacted, or refuse.
 *
 * @param {object} deps
 * @param {import('./pathBoundary.js').PathBoundary} deps.boundary
 * @param {{redact(text: string): string}} deps.redactor
 * @param {string} candidate Absolute or workspace-relative.
 * @param {object} [options]
 * @param {number} [options.maxBytes]
 * @param {boolean} [options.redact] Internal. `boundedReadJson` parses raw text and
 *   redacts the parsed tree instead; see the note there. Every OTHER caller gets
 *   redacted text, and there is a test that asserts no capability reads raw.
 */
export function boundedRead(
  { boundary, redactor },
  candidate,
  { maxBytes = DEFAULT_MAX_READ_BYTES, redact = true } = {},
) {
  const resolved = boundary.resolve(candidate, PathIntent.READ);
  if (!resolved.ok) {
    // Includes every deny-list refusal. The file is never opened.
    return { ok: false, error: resolved.error };
  }

  let handle;
  try {
    handle = fs.openSync(resolved.path.absolutePath, 'r');
  } catch (thrown) {
    return {
      ok: false,
      relativePath: resolved.path.relativePath,
      error: agentError({
        code: thrown?.code === 'ENOENT' ? ErrorCode.FILE_NOT_FOUND : ErrorCode.FILE_READ_FAILED,
        category: thrown?.code === 'ENOENT' ? ErrorCategory.NOT_FOUND : ErrorCategory.ENVIRONMENT,
        message: 'The file could not be opened.',
        remediation: 'Check that the path names a readable file inside the workspace.',
        detail: `path='${resolved.path.relativePath}'`,
      }),
    };
  }

  try {
    const stats = fs.fstatSync(handle);
    if (stats.isDirectory()) {
      return {
        ok: false,
        relativePath: resolved.path.relativePath,
        error: agentError({
          code: ErrorCode.FILE_READ_FAILED,
          category: ErrorCategory.ENVIRONMENT,
          message: 'The path names a directory, not a file.',
          remediation: 'Name a file inside the workspace.',
          detail: `path='${resolved.path.relativePath}'`,
        }),
      };
    }
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = fs.readSync(handle, buffer, 0, maxBytes, 0);
    const raw = buffer.subarray(0, bytesRead).toString('utf8');
    return {
      ok: true,
      text: redact ? redactor.redact(raw) : raw,
      relativePath: resolved.path.relativePath,
      truncated: stats.size > bytesRead,
      bytesRead,
    };
  } catch (thrown) {
    return {
      ok: false,
      relativePath: resolved.path.relativePath,
      error: agentError({
        code: ErrorCode.FILE_READ_FAILED,
        category: ErrorCategory.ENVIRONMENT,
        message: 'The file could not be read.',
        remediation: 'Check file permissions and that the path is not a directory.',
        detail: `reason=${thrown?.code ?? 'unknown'}`,
      }),
    };
  } finally {
    try {
      fs.closeSync(handle);
    } catch {
      /* closing a handle we already hold is best-effort */
    }
  }
}

/**
 * Read and parse JSON through the same door.
 *
 * The RAW text is parsed and the PARSED VALUES are then redacted by key, rather
 * than redacting the text and parsing the result. That ordering is deliberate
 * and it fixes a real failure mode: a redaction marker substituted into a string
 * that contains an escaped quote produces text that is no longer valid JSON, and
 * the manifest would then be reported as unparseable when it was merely
 * sensitive. Redacting the parsed tree also lets the KEY drive the decision,
 * which is the more reliable signal for structured data - `password: "admin"` is
 * obviously a secret and `admin` alone obviously is not.
 *
 * The raw text is never returned and never stored; only the redacted tree
 * leaves this function.
 *
 * Returns a structured refusal when the file is denied, absent, truncated or
 * unparseable - never a thrown exception, and never a silent `{}`. An agent must
 * be able to tell "no dependencies" from "the manifest did not parse", which is
 * exactly the distinction Python's discovery makes and C#'s does not.
 */
export function boundedReadJson(deps, candidate, { maxBytes = 1_048_576 } = {}) {
  const read = boundedRead(deps, candidate, { maxBytes, redact: false });
  if (!read.ok) return { ok: false, error: read.error, relativePath: read.relativePath };

  if (read.truncated) {
    return {
      ok: false,
      relativePath: read.relativePath,
      error: agentError({
        code: ErrorCode.MANIFEST_UNREADABLE,
        category: ErrorCategory.ENVIRONMENT,
        message: 'The file is larger than the read limit, so it could not be parsed.',
        remediation: 'This is almost certainly not a real manifest. Check the path.',
        detail: `path='${read.relativePath}'`,
      }),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return {
      ok: false,
      relativePath: read.relativePath,
      error: agentError({
        code: ErrorCode.MANIFEST_UNREADABLE,
        category: ErrorCategory.ENVIRONMENT,
        message: 'The file was found but is not valid JSON.',
        remediation: 'Do not read this as "empty". Fix the file, or exclude it from the workspace.',
        detail: `path='${read.relativePath}'`,
      }),
    };
  }

  return {
    ok: true,
    value: redactJsonValues(parsed, deps.redactor),
    truncated: false,
    relativePath: read.relativePath,
  };
}

/** Longest structure redaction will walk. A bound, not a guess: JSON can nest arbitrarily. */
const MAX_JSON_DEPTH = 24;

/**
 * Walk a parsed JSON tree and redact every string value whose KEY names a
 * secret, falling back to value-shape redaction for the rest.
 *
 * @param {unknown} value
 * @param {{redact(text: string): string, redactValue(key: string, value: string): string}} redactor
 * @param {string} [key]
 * @param {number} [depth]
 */
export function redactJsonValues(value, redactor, key = '', depth = 0) {
  if (depth > MAX_JSON_DEPTH) return value;
  if (typeof value === 'string') {
    return key ? redactor.redactValue(key, value) : redactor.redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValues(entry, redactor, key, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = redactJsonValues(childValue, redactor, childKey, depth + 1);
    }
    return out;
  }
  return value;
}
