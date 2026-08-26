/**
 * File-access containment: the single most important control in the product.
 *
 * The agent is a language model. Sooner or later a web page, a test fixture or a
 * persuasive prompt will get it to ask for a path it should not have. THE
 * SERVER REFUSES, NOT THE MODEL.
 *
 * The order of checks is deliberate and this module exists to make the classic
 * mistake impossible:
 *
 *   1. Reject structurally hostile input first — empty, NUL bytes, UNC and
 *      device paths, alternate data streams, Windows drive-relative paths.
 *   2. THEN canonicalise, so `..` is resolved rather than pattern-matched.
 *   3. THEN test containment against the canonical form.
 *   4. THEN apply the deny-list.
 *   5. THEN apply the write-intent rules.
 *
 * Testing containment before canonicalisation is how `../../secret` gets
 * through, and no amount of review reliably catches it once the code is written
 * the other way round.
 *
 * TWO THINGS HERE ARE STRONGER THAN THE C# SIBLING, both for JavaScript reasons.
 *
 * `fs.realpathSync.native` RESOLVES SYMLINKS AND NTFS JUNCTIONS. `path.resolve`
 * does not — it is purely lexical, exactly like .NET's `Path.GetFullPath`, which
 * means the C# product has a symlink escape with no test for it. A link inside
 * the workspace pointing at `C:\` would canonicalise to the link's own path,
 * pass containment, and read outside the workspace on I/O. There is a test for
 * exactly that case here.
 *
 * Containment uses `path.relative`, which compares PATH SEGMENTS. A string
 * prefix check would treat `C:\work-secrets` as inside `C:\work`.
 *
 * And the Windows-only structural checks are PURE FUNCTIONS taking an explicit
 * `windows` flag, so Windows attack shapes are asserted on every CI platform
 * rather than only on the Windows runner — because no product in this family has
 * ever run on Windows, and asserting them only there would mean never asserting
 * them at all.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ErrorCategory } from '../contract/vocabularies.js';
import { ErrorCode } from '../contract/errorCodes.js';
import { agentError } from '../contract/agentError.js';
import { firstMatchingGlob } from './globs.js';
import { deepFreeze } from '../support/freeze.js';

/** Directory GenXEvo uses for its own run and evidence data, inside the workspace. */
export const AGENT_DATA_DIRECTORY = '.genxevo';

/** Longest candidate echoed back in a refusal. */
export const MAX_ECHOED_PATH = 200;

/** What the caller intends to do with a path. Write is held to a stricter policy. */
export const PathIntent = Object.freeze({ READ: 'read', WRITE: 'write' });

/**
 * The brand that makes a `ResolvedPath` unforgeable outside this module.
 *
 * JavaScript cannot give the compile-time guarantee C#'s `ResolvedPath` type and
 * Java's sealed interface provide, and pretending otherwise would be a borrowed
 * conclusion. What it CAN do is this: only `PathBoundary` sets the brand, every
 * consumer that performs I/O asserts it, and a test enumerates the call sites.
 * Three mechanisms, none of them a compiler, and the documentation says so.
 */
const RESOLVED = Symbol('genxevo.resolvedPath');

/**
 * @typedef {object} ResolvedPath
 * @property {string} absolutePath  Canonical, used for I/O. NEVER sent to the agent.
 * @property {string} relativePath  Relative to `root`, forward slashes. This is what the agent sees.
 * @property {string} root
 */

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isResolvedPath(value) {
  return Boolean(value) && typeof value === 'object' && value[RESOLVED] === true;
}

/**
 * Reject structurally hostile input before any filesystem call is made.
 *
 * A pure function taking `windows` explicitly, so every Windows rule is testable
 * on every platform.
 *
 * @param {string} candidate
 * @param {object} options
 * @param {boolean} options.windows
 * @returns {import('../contract/agentError.js').AgentError | null}
 */
export function checkStructure(candidate, { windows }) {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    return malformed('The path was empty.');
  }
  if (candidate.includes('\0')) {
    return malformed('The path contained a null character.');
  }
  if (candidate.startsWith('\\\\') || candidate.startsWith('//')) {
    return malformed('Device paths, UNC paths and extended-length prefixes are not accepted.');
  }
  if (windows) {
    if (hasAlternateDataStream(candidate)) {
      return malformed('Alternate data stream syntax is not accepted.');
    }
    if (isDriveRelative(candidate)) {
      // `C:foo` resolves against a PER-DRIVE current directory, which is process
      // state the agent must never be able to lean on. Neither sibling tests this.
      return malformed(
        'Drive-relative paths are not accepted, because they resolve against a per-drive current directory.',
      );
    }
  }
  return null;
}

/**
 * Windows alternate-data-stream syntax, such as `file.txt:hidden`.
 *
 * On Windows a colon is legal ONLY as the drive separator at index 1. On POSIX a
 * colon is an ordinary filename character, which is why the caller gates this on
 * the platform rather than applying it everywhere.
 *
 * This checks EVERY colon, not just the first, and that is a deliberate
 * correction to both sibling products. Their implementations test
 * `firstColon >= 0 && firstColon !== 1`, which accepts
 * `C:\\project\\file.txt:hidden` — the first colon is the legitimate drive
 * separator, so the stream suffix after it is never examined. An absolute
 * Windows path with an alternate data stream is the more likely shape of the
 * two, and it is the one that got through.
 */
function hasAlternateDataStream(candidate) {
  for (
    let index = candidate.indexOf(':');
    index !== -1;
    index = candidate.indexOf(':', index + 1)
  ) {
    if (index !== 1) return true;
  }
  return false;
}

function isDriveRelative(candidate) {
  return /^[A-Za-z]:(?![\\/])/.test(candidate);
}

/** Enforces that all file access stays inside explicitly approved roots. */
export class PathBoundary {
  #roots;
  #deniedGlobs;
  #caseSensitive;

  /**
   * @param {Iterable<string>} roots  Absolute directory paths. At least one is required.
   * @param {object} [options]
   * @param {Iterable<string>} [options.deniedGlobs]
   * @param {boolean} [options.caseSensitive] Null/undefined selects the platform convention.
   * @param {boolean} [options.windows]
   */
  constructor(roots, { deniedGlobs = [], caseSensitive, windows } = {}) {
    this.windows = windows ?? process.platform === 'win32';
    this.#caseSensitive = caseSensitive ?? !(this.windows || process.platform === 'darwin');

    const resolved = [];
    for (const root of roots ?? []) {
      const text = String(root ?? '').trim();
      if (!text) continue;
      let canonical;
      try {
        canonical = canonicalise(text);
      } catch {
        continue;
      }
      if (!resolved.includes(canonical)) resolved.push(canonical);
    }

    if (resolved.length === 0) {
      // GenXEvo never falls back to "the current directory". An unconfigured
      // boundary is a refusal, not a default.
      throw new PathBoundaryError('A PathBoundary requires at least one absolute root directory.');
    }

    this.#roots = Object.freeze(resolved);
    this.#deniedGlobs = Object.freeze(
      [...(deniedGlobs ?? [])].filter((g) => g && String(g).trim()),
    );
  }

  /** The approved roots, canonicalised. */
  get roots() {
    return this.#roots;
  }

  get caseSensitive() {
    return this.#caseSensitive;
  }

  get deniedGlobs() {
    return this.#deniedGlobs;
  }

  /**
   * Validate a caller-supplied path.
   *
   * Returns a discriminated object rather than throwing. A refusal is an
   * ordinary, expected outcome that the caller must turn into a `blocked`
   * result, and an exception invites a bare `catch` that swallows it.
   *
   * @param {string | null | undefined} candidate Absolute, or relative to the first root.
   * @param {string} [intent]
   * @returns {{ok: true, path: ResolvedPath} | {ok: false, error: import('../contract/agentError.js').AgentError}}
   */
  resolve(candidate, intent = PathIntent.READ) {
    const text = candidate === null || candidate === undefined ? '' : String(candidate);

    const structural = checkStructure(text, { windows: this.windows });
    if (structural) return { ok: false, error: structural };

    let absolute;
    try {
      absolute = canonicalise(path.isAbsolute(text) ? text : path.join(this.#roots[0], text));
    } catch (thrown) {
      return {
        ok: false,
        error: malformed(
          `The path could not be canonicalised (${thrown?.constructor?.name ?? 'Error'}).`,
        ),
      };
    }

    const root = this.#containingRoot(absolute);
    if (root === null) {
      return {
        ok: false,
        error: agentError({
          code: ErrorCode.PATH_OUTSIDE_WORKSPACE,
          category: ErrorCategory.SECURITY,
          message: 'The requested path resolves outside every approved workspace root.',
          remediation:
            "Use a path inside the configured workspace, or ask the operator to add the folder to 'workspace.roots' in the GenXEvo configuration.",
          // The CANDIDATE is echoed, never the resolved absolute path. Telling
          // the agent where the boundary actually sits would help anything
          // influencing it to probe that boundary.
          detail: `requested='${truncatePath(text)}'`,
        }),
      };
    }

    const relativePath = toRelativeFrom(absolute, root);

    const denied = firstMatchingGlob(relativePath, this.#deniedGlobs, {
      caseSensitive: this.#caseSensitive,
    });
    if (denied !== null) {
      return {
        ok: false,
        error: agentError({
          code: ErrorCode.PATH_DENIED,
          category: ErrorCategory.SECURITY,
          message: 'The requested path is inside the workspace but is on the deny list.',
          remediation:
            "This file is protected because it commonly contains credentials. If it is genuinely required, the operator can change 'security.deniedFileGlobs'.",
          detail: `path='${relativePath}' pattern='${denied}'`,
        }),
      };
    }

    if (intent === PathIntent.WRITE && isInsideAgentData(relativePath)) {
      return {
        ok: false,
        error: agentError({
          code: ErrorCode.PATH_DENIED,
          category: ErrorCategory.SECURITY,
          message: 'Writes into the GenXEvo working directory are not permitted from a capability.',
          remediation: `Write outputs elsewhere in the workspace. GenXEvo manages '${AGENT_DATA_DIRECTORY}/' itself.`,
          detail: `path='${relativePath}'`,
        }),
      };
    }

    return {
      ok: true,
      path: deepFreeze({ [RESOLVED]: true, absolutePath: absolute, relativePath, root }),
    };
  }

  /**
   * Convert an absolute path inside a root to the agent-facing relative form.
   *
   * Falls back to the bare file name when the path is not inside any root, so an
   * absolute path can never leak into a result through this method.
   *
   * @param {string} absolute
   * @returns {string}
   */
  toRelative(absolute) {
    const text = String(absolute ?? '');
    if (!text.trim()) return '';
    let canonical;
    try {
      canonical = canonicalise(text);
    } catch {
      return path.basename(text);
    }
    const root = this.#containingRoot(canonical);
    return root === null ? path.basename(canonical) : toRelativeFrom(canonical, root);
  }

  #containingRoot(candidate) {
    for (const root of this.#roots) {
      if (isContained(candidate, root, this.#caseSensitive)) return root;
    }
    return null;
  }
}

export class PathBoundaryError extends Error {}

/**
 * Canonicalise a path, resolving symlinks and junctions.
 *
 * `fs.realpathSync.native` throws `ENOENT` for a path that does not exist yet —
 * which a write intent legitimately produces, and which a read of a
 * not-yet-created file also produces. So the deepest EXISTING ancestor is
 * realpath'd and the remaining segments are appended lexically. That still
 * resolves every symlink in the existing prefix, which is where an escape would
 * actually live: a link cannot be traversed if it does not exist.
 *
 * @param {string} input
 * @returns {string}
 */
export function canonicalise(input) {
  const lexical = path.resolve(input);
  let current = lexical;
  const tail = [];

  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return tail.length === 0
        ? stripTrailingSeparator(real)
        : stripTrailingSeparator(path.join(real, ...tail.reverse()));
    } catch (thrown) {
      if (thrown?.code !== 'ENOENT' && thrown?.code !== 'ENOTDIR') throw thrown;
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root without finding anything that exists.
        return stripTrailingSeparator(lexical);
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function stripTrailingSeparator(value) {
  if (value.length > 1 && (value.endsWith(path.sep) || value.endsWith('/'))) {
    const trimmed = value.slice(0, -1);
    // Keep `C:\` and `/`.
    return /^[A-Za-z]:$/.test(trimmed) ? value : trimmed;
  }
  return value;
}

/**
 * Part-wise containment. `path.relative` compares segments, which is what stops
 * `/work-secrets` from being treated as contained in `/work`.
 */
function isContained(candidate, root, caseSensitive) {
  const a = caseSensitive ? candidate : candidate.toLowerCase();
  const b = caseSensitive ? root : root.toLowerCase();
  if (a === b) return true;
  const relative = path.relative(b, a);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function toRelativeFrom(absolute, root) {
  if (absolute === root) return '.';
  return path.relative(root, absolute).split(path.sep).join('/');
}

function isInsideAgentData(relativePath) {
  const normalised = relativePath.replaceAll('\\', '/').toLowerCase();
  return normalised === AGENT_DATA_DIRECTORY || normalised.startsWith(`${AGENT_DATA_DIRECTORY}/`);
}

function malformed(message) {
  return agentError({
    code: ErrorCode.PATH_MALFORMED,
    category: ErrorCategory.SECURITY,
    message,
    remediation:
      "Supply a plain relative path inside the workspace, for example 'test/login.test.js'.",
  });
}

function truncatePath(value) {
  return value.length <= MAX_ECHOED_PATH ? value : `${value.slice(0, MAX_ECHOED_PATH)}...`;
}

/** Exposed for tests that need a real temporary workspace. */
export function realTempDirectory(prefix = 'genxevo-') {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
