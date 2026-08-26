import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  FileRunRegistry,
  RunLookupFailure,
  RunStatus,
  isValidRunId,
  newRunId,
  runOutcome,
  runRecord,
} from '../src/core/runs/runModel.js';
import { fixedClock } from '../src/core/support/clock.js';
import { fixedTokens, SECURE_TOKENS } from '../src/core/support/tokens.js';
import { tempWorkspace } from './helpers/fixtures.js';

const CLOCK = fixedClock('2026-08-25T09:15:00.000Z');
const TOKENS = fixedTokens('ab12cd');

function registry() {
  return new FileRunRegistry(path.join(tempWorkspace(), '.genxevo', 'runs'));
}

function completed(runId, overrides = {}) {
  return runRecord({
    runId,
    status: RunStatus.COMPLETED,
    startedAt: '2026-08-25T09:15:00Z',
    outcome: runOutcome({ total: 3, passed: 3 }),
    resultArtifactPath: `.genxevo/runs/${runId}/results.json`,
    ...overrides,
  });
}

test('the identifier format is exactly as published, and sorts by time as a plain string', () => {
  const id = newRunId(CLOCK, TOKENS);
  assert.equal(id, 'run_20260825T091500Z_ab12cd');
  assert.ok(isValidRunId(id));

  const earlier = newRunId(fixedClock('2026-01-01T00:00:00Z'), TOKENS);
  assert.ok(earlier < id, 'identifiers must sort chronologically as strings');
});

test('the random component comes from a CRYPTOGRAPHIC source', () => {
  // A predictable identifier would let anything able to write inside the
  // workspace pre-create or clobber a run directory, and correlation would stop
  // being trustworthy.
  const tokens = new Set();
  for (let i = 0; i < 200; i += 1) tokens.add(SECURE_TOKENS.nextToken());
  assert.ok(tokens.size > 190, 'tokens must not collide');
  for (const token of tokens) assert.match(token, /^[0-9a-f]{6}$/);
  assert.throws(() => SECURE_TOKENS.nextToken(0), RangeError);
  assert.throws(() => SECURE_TOKENS.nextToken(99), RangeError);
});

test('malformed identifiers are rejected', () => {
  for (const candidate of [
    '',
    null,
    undefined,
    'run_x',
    '../evil',
    'run_20260825T091500Z_ZZZZZZ',
    'run_2026825T091500Z_ab12cd',
    'run_20260825T091500Z_ab12cd/../../etc',
    'RUN_20260825T091500Z_ab12cd',
  ]) {
    assert.equal(isValidRunId(candidate), false, String(candidate));
  }
});

test('a malformed identifier can NEVER become a path', () => {
  // That is path traversal wearing a different hat.
  const store = registry();
  for (const candidate of ['../evil', 'run_x', '', 'a/../../b']) {
    assert.throws(() => store.directoryFor(candidate), TypeError, String(candidate));
  }
  assert.throws(
    () => runRecord({ runId: '../evil', status: RunStatus.PENDING, startedAt: 'x' }),
    TypeError,
  );
});

test('each run OWNS its own directory, and an identifier is never reused', () => {
  const store = registry();
  const id = newRunId(CLOCK, TOKENS);
  store.create(completed(id));
  assert.ok(fs.existsSync(store.directoryFor(id)));
  assert.throws(() => store.create(completed(id)), /never reused/);
});

test('a record round-trips, including its derived assertions', () => {
  const store = registry();
  const id = newRunId(CLOCK, TOKENS);
  store.create(completed(id));
  const found = store.get(id);
  assert.equal(found.ok, true);
  assert.equal(found.record.runId, id);
  assert.equal(found.record.outcome.isGreen, true);
  assert.equal(found.record.hasTrustworthyResults, true);
});

test('updating a run that was never created is refused', () => {
  const store = registry();
  assert.throws(() => store.update(completed(newRunId(CLOCK, TOKENS))), /has not been created/);
});

test('an unknown run and an UNREADABLE run are DIFFERENT answers', () => {
  // Both siblings return null for every failure, so a corrupt run.json is
  // indistinguishable from "no such run" - and both define an
  // environment.file_read_failed code that consequently goes unused. The two
  // lead an agent to different next actions.
  const store = registry();
  const id = newRunId(CLOCK, TOKENS);
  assert.deepEqual(store.get(id), { ok: false, reason: RunLookupFailure.NOT_FOUND });

  store.create(completed(id));
  fs.writeFileSync(path.join(store.directoryFor(id), 'run.json'), '{ half-writ', 'utf8');
  assert.deepEqual(store.get(id), { ok: false, reason: RunLookupFailure.UNREADABLE });
});

test('a record missing required fields reads as UNREADABLE, not as an empty run', () => {
  const store = registry();
  const id = newRunId(CLOCK, TOKENS);
  store.create(completed(id));
  fs.writeFileSync(path.join(store.directoryFor(id), 'run.json'), '{"notes":[]}', 'utf8');
  assert.equal(store.get(id).reason, RunLookupFailure.UNREADABLE);
});

test('listing orders by IDENTIFIER, not by file timestamp', () => {
  // The identifier embeds the start instant, so history stays correctly ordered
  // even if a file is touched, copied or restored from a backup later.
  const store = registry();
  const older = newRunId(fixedClock('2026-08-24T09:00:00Z'), fixedTokens('aaaaaa'));
  const newer = newRunId(fixedClock('2026-08-25T09:00:00Z'), fixedTokens('bbbbbb'));
  store.create(completed(older));
  store.create(completed(newer));

  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(store.directoryFor(older), 'run.json'), future, future);

  assert.deepEqual(
    store.list().map((r) => r.runId),
    [newer, older],
  );
});

test('listing ignores directories that are not runs', () => {
  const store = registry();
  const id = newRunId(CLOCK, TOKENS);
  store.create(completed(id));
  fs.mkdirSync(path.join(store.root, 'scratch'));
  fs.mkdirSync(path.join(store.root, 'run_not_a_real_id'));
  assert.deepEqual(
    store.list().map((r) => r.runId),
    [id],
  );
});

test('a write leaves no temporary file behind', () => {
  const store = registry();
  const id = newRunId(CLOCK, TOKENS);
  store.create(completed(id));
  assert.deepEqual(fs.readdirSync(store.directoryFor(id)), ['run.json']);
});

test('an empty registry lists nothing rather than failing', () => {
  assert.deepEqual(registry().list(), []);
  assert.throws(() => new FileRunRegistry('   '), TypeError);
});

test('EVERY bucket a JavaScript runner can report is counted', () => {
  // Re-derived from node:test, mocha, jest and vitest - NOT inherited from
  // VSTest (inconclusive/aborted) or pytest (xfailed/xpassed).
  const outcome = runOutcome({ total: 10, passed: 5, failed: 2, skipped: 1, todo: 1, errored: 1 });
  assert.deepEqual(Object.keys(outcome).slice(0, 6), [
    'total',
    'passed',
    'failed',
    'skipped',
    'todo',
    'errored',
  ]);
  assert.equal(outcome.isConsistent, true);
});

test('an inconsistent outcome is reported as such', () => {
  assert.equal(runOutcome({ total: 5, passed: 4 }).isConsistent, false);
});

test('`errored` is counted separately, because one broken import is not one failure', () => {
  // In JavaScript a broken import takes out an entire file's worth of tests and
  // reports as ONE error. A model that only sees `failed` reads a catastrophe as
  // a small problem.
  const outcome = runOutcome({ total: 1, errored: 1 });
  assert.equal(outcome.isGreen, false);
  assert.equal(outcome.isConsistent, true);
});

test('a run of ZERO tests is never green', () => {
  // This is what stops a mistyped selection from being mistaken for a repair.
  assert.equal(runOutcome({ total: 0 }).isGreen, false);
});

test('an all-skipped run is never green', () => {
  assert.equal(runOutcome({ total: 5, skipped: 5 }).isGreen, false);
});

test('a genuinely passing run is green, and `todo` does not block it', () => {
  assert.equal(runOutcome({ total: 5, passed: 5 }).isGreen, true);
  assert.equal(runOutcome({ total: 5, passed: 4, todo: 1 }).isGreen, true);
  assert.equal(runOutcome({ total: 5, passed: 4, skipped: 1 }).isGreen, true);
});

test('a failure or an error prevents green even when other tests passed', () => {
  assert.equal(runOutcome({ total: 5, passed: 4, failed: 1 }).isGreen, false);
  assert.equal(runOutcome({ total: 5, passed: 4, errored: 1 }).isGreen, false);
});

test('results from a run that did not complete are NEVER trustworthy', () => {
  for (const status of [
    RunStatus.PENDING,
    RunStatus.RUNNING,
    RunStatus.TIMED_OUT,
    RunStatus.CANCELLED,
    RunStatus.FAULTED,
  ]) {
    const record = completed(newRunId(CLOCK, TOKENS), { status });
    assert.equal(record.hasTrustworthyResults, false, status);
  }
});

test('a completed run with no artefact, or inconsistent counts, is not trustworthy', () => {
  const id = newRunId(CLOCK, TOKENS);
  assert.equal(completed(id, { resultArtifactPath: null }).hasTrustworthyResults, false);
  assert.equal(
    completed(id, { outcome: runOutcome({ total: 5, passed: 1 }) }).hasTrustworthyResults,
    false,
  );
});

test('a run record NEVER carries an absolute path', () => {
  const record = completed(newRunId(CLOCK, TOKENS));
  assert.equal(record.resultArtifactPath.startsWith('.genxevo/'), true);
  assert.equal(path.isAbsolute(record.resultArtifactPath), false);
});
