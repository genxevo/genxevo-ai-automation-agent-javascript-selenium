/**
 * The run model: one execution, one identifier, one directory.
 *
 * This is the direct answer to the stale-results defect catalogued across this
 * product family, where a fixed artefact name plus a "read the newest file"
 * lookup let an agent read a previous day's results as evidence that today's
 * repair had worked. That is the most dangerous class of bug this product can
 * have, because the agent does not merely fail — it succeeds, loudly, at
 * nothing.
 *
 * Correlation here is STRUCTURAL, NOT HEURISTIC. A result file cannot be
 * attributed to the wrong run because it physically cannot appear in another
 * run's directory.
 *
 * The runner itself arrives in phase 1D. What is built now is the identity, the
 * record, the outcome arithmetic and the registry — the parts a runner must not
 * be allowed to invent for itself.
 */

import fs from 'node:fs';
import path from 'node:path';

import { deepFreeze } from '../support/freeze.js';
import { isoUtc } from '../contract/evidence.js';

export const RUN_ID_PREFIX = 'run_';
export const RECORD_FILE_NAME = 'run.json';

const RUN_ID_PATTERN = /^run_(\d{8}T\d{6}Z)_([0-9a-f]{6,12})$/;

/** Lifecycle state of a test run. */
export const RunStatus = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  /** Finished and its results were parsed. Says nothing about whether tests passed. */
  COMPLETED: 'completed',
  TIMED_OUT: 'timedOut',
  CANCELLED: 'cancelled',
  /** Could not be executed, or its results could not be read. */
  FAULTED: 'faulted',
});

export const RUN_STATUS_VALUES = Object.freeze(Object.values(RunStatus));

/**
 * Create a run identifier.
 *
 * `run_YYYYMMDDTHHMMSSZ_xxxxxx`: sortable by time, unique through the random
 * suffix, safe as a directory name on every platform, and readable by a human
 * scanning a folder listing.
 */
export function newRunId(clock, tokens) {
  const stamp = isoUtc(clock.now())
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `${RUN_ID_PREFIX}${stamp}_${tokens.nextToken()}`;
}

/**
 * True when the value is a well-formed run identifier.
 *
 * Used to validate agent-supplied identifiers BEFORE they touch the filesystem.
 * An identifier concatenated into a path without this check is path traversal
 * wearing a different hat.
 */
export function isValidRunId(value) {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value);
}

/**
 * The counted outcome of a run, in JAVASCRIPT'S OWN VOCABULARY.
 *
 * The buckets are re-derived rather than inherited, and the derivation matters.
 * C#'s are VSTest's (`inconclusive`, `aborted`); Python's are pytest's
 * (`xfailed`, `xpassed`). JavaScript runners agree on less than either:
 *
 *   node:test   pass, fail, cancelled, skipped, todo
 *   mocha       passing, failing, pending
 *   jest        passed, failed, skipped, todo, plus suite-level failures
 *   vitest      passed, failed, skipped, todo
 *
 * The common denominator is total / passed / failed / skipped / todo / errored,
 * and `errored` matters most: in JavaScript a broken import takes out an entire
 * file's worth of tests and reports as ONE error rather than N failures, so a
 * model that only sees `failed` reads a catastrophe as a small problem.
 *
 * AND THERE IS NO `xpassed` ANALOGUE. Python's `xpassed` is often the evidence
 * that a repair worked. `todo` looks similar and is not: Jest reports a `todo`
 * test as `todo` whether or not its body would pass, so an unexpectedly-passing
 * `todo` is invisible. The "repair worked" signal in JavaScript is therefore a
 * COMPARISON between two runs, not a bucket — which places it in
 * `genxevo_compare_runs` in phase 1D. Inventing an `xpassed` field that nothing
 * could ever populate would be symmetry for its own sake.
 */
export function runOutcome({
  total = 0,
  passed = 0,
  failed = 0,
  skipped = 0,
  todo = 0,
  errored = 0,
} = {}) {
  const outcome = { total, passed, failed, skipped, todo, errored };
  outcome.isConsistent = passed + failed + skipped + todo + errored === total;
  /**
   * `passed > 0` is required. A mistyped selection that collected zero tests can
   * never look like a successful repair.
   */
  outcome.isGreen = total > 0 && passed > 0 && failed === 0 && errored === 0;
  return deepFreeze(outcome);
}

export const EMPTY_OUTCOME = runOutcome();

/** A durable record of one test execution. */
export function runRecord({
  runId,
  status,
  startedAt,
  selection = null,
  selectionKind = null,
  projectPath = null,
  runner = null,
  nodeExecutable = null,
  commandDisplay = null,
  completedAt = null,
  durationMs = null,
  exitCode = null,
  outcome = EMPTY_OUTCOME,
  resultArtifactPath = null,
  previousRunId = null,
  notes = [],
}) {
  if (!isValidRunId(runId)) {
    throw new TypeError(`'${runId}' is not a valid run identifier.`);
  }
  const record = {
    runId,
    status,
    startedAt: startedAt instanceof Date ? isoUtc(startedAt) : startedAt,
    selection,
    selectionKind,
    projectPath,
    runner,
    nodeExecutable,
    commandDisplay,
    completedAt: completedAt instanceof Date ? isoUtc(completedAt) : completedAt,
    durationMs,
    exitCode,
    outcome,
    resultArtifactPath,
    previousRunId,
    notes: [...notes],
  };
  /**
   * False whenever the run timed out, was cancelled or faulted: in those cases
   * the artefact may be absent or half-written, and an agent must not draw a
   * verdict from it.
   */
  record.hasTrustworthyResults =
    status === RunStatus.COMPLETED && outcome.isConsistent && resultArtifactPath !== null;
  return deepFreeze(record);
}

/** Why a run could not be returned. Distinguishing these is an improvement on both siblings. */
export const RunLookupFailure = Object.freeze({
  NOT_FOUND: 'notFound',
  UNREADABLE: 'unreadable',
});

/**
 * A run registry backed by one directory per run.
 *
 * Layout: `<workspace>/.genxevo/runs/<runId>/`, holding `run.json` plus whatever
 * artefacts that run produced.
 */
export class FileRunRegistry {
  #root;

  constructor(runsDirectory) {
    const text = String(runsDirectory ?? '').trim();
    if (!text) throw new TypeError('A run registry needs a runs directory.');
    this.#root = path.resolve(text);
  }

  get root() {
    return this.#root;
  }

  /** @throws {TypeError} when the identifier is malformed. It must never become a path. */
  directoryFor(runId) {
    if (!isValidRunId(runId)) throw new TypeError(`'${runId}' is not a valid run identifier.`);
    return path.join(this.#root, runId);
  }

  create(record) {
    const directory = this.directoryFor(record.runId);
    if (fs.existsSync(directory)) {
      throw new Error(`Run '${record.runId}' already exists. Run identifiers are never reused.`);
    }
    fs.mkdirSync(directory, { recursive: true });
    this.#write(record);
    return record;
  }

  update(record) {
    const directory = this.directoryFor(record.runId);
    if (!fs.existsSync(directory)) {
      throw new Error(`Run '${record.runId}' has not been created.`);
    }
    this.#write(record);
  }

  /**
   * Return a run by identifier.
   *
   * BOTH SIBLINGS RETURN NULL FOR EVERY FAILURE, so a corrupt `run.json` is
   * indistinguishable from "no such run" — and both define an
   * `environment.file_read_failed` code that consequently goes unused. Here the
   * two are distinct, because "your run is gone" and "your run is unreadable"
   * lead an agent to different next actions.
   *
   * @returns {{ok: true, record: object} | {ok: false, reason: string}}
   */
  get(runId) {
    if (!isValidRunId(runId)) return { ok: false, reason: RunLookupFailure.NOT_FOUND };
    const file = path.join(this.#root, runId, RECORD_FILE_NAME);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (thrown) {
      return {
        ok: false,
        reason:
          thrown?.code === 'ENOENT' ? RunLookupFailure.NOT_FOUND : RunLookupFailure.UNREADABLE,
      };
    }
    try {
      const parsed = JSON.parse(raw);
      if (!isValidRunId(parsed?.runId) || typeof parsed?.status !== 'string') {
        return { ok: false, reason: RunLookupFailure.UNREADABLE };
      }
      return { ok: true, record: deepFreeze(parsed) };
    } catch {
      return { ok: false, reason: RunLookupFailure.UNREADABLE };
    }
  }

  /**
   * The most recent runs, newest first.
   *
   * Ordering is by IDENTIFIER, not by file modification time. The identifier
   * embeds the start instant, so history stays correctly ordered even if a file
   * is touched, copied or restored from a backup later.
   */
  list(limit = 20) {
    if (!fs.existsSync(this.#root)) return [];
    const capped = Math.max(1, Math.min(limit, 500));
    const names = fs
      .readdirSync(this.#root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidRunId(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, capped);
    return names
      .map((name) => this.get(name))
      .filter((r) => r.ok)
      .map((r) => r.record);
  }

  #write(record) {
    const file = path.join(this.directoryFor(record.runId), RECORD_FILE_NAME);
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2), 'utf8');
    try {
      // Atomic on POSIX and on Windows within a volume, so a crash mid-write can
      // never leave a half-parsed record that a later read would misinterpret.
      fs.renameSync(temporary, file);
    } catch (thrown) {
      if (thrown?.code !== 'EXDEV') throw thrown;
      // A cross-device rename is not atomic and not possible. Copy-then-unlink is
      // the only option; the window is real and is documented rather than hidden.
      fs.copyFileSync(temporary, file);
      fs.unlinkSync(temporary);
    }
  }
}
