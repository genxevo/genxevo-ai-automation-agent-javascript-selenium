import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_REDACTION_INPUT,
  NullSecretRedactor,
  REDACTION_MARKER,
  SecretRedactor,
  normaliseKey,
} from '../src/core/security/redaction.js';

const redactor = new SecretRedactor();

/**
 * Every credential-shaped literal in this file is SYNTHETIC. `Winter2026!` and
 * `hunter2` are invented; the JWT is the textbook HS256 example whose payload is
 * {"sub":"12345"} and which signs nothing; the PEM body is literally digits and
 * the alphabet; `example.com` and `example.test` are RFC 2606 reserved names.
 */

test('key names: the family fragments are recognised', () => {
  for (const key of [
    'password',
    'PASSWORD',
    'db_password',
    'apiKey',
    'API_KEY',
    'clientSecret',
    'connectionString',
    'authToken',
    'sessionId',
    'cookie',
    'passphrase',
    'npmAuthToken',
    'AUTHORIZATION',
  ]) {
    assert.equal(redactor.isSensitiveKey(key), true, key);
  }
});

test('key names: ordinary keys stay readable', () => {
  for (const key of ['baseUrl', 'timeout', 'browser', 'name', 'version', 'testMatch']) {
    assert.equal(redactor.isSensitiveKey(key), false, key);
  }
});

test('key names: an exemption is a WHOLE identifier, not a substring', () => {
  // The bug both siblings have: they test `normalised.includes(exemption)` and
  // short-circuit, so `AuthModePassword` contains `authmode`, is declared
  // non-sensitive, and its value is emitted verbatim.
  assert.equal(redactor.isSensitiveKey('authMode'), false, 'a genuine exemption still applies');
  assert.equal(redactor.isSensitiveKey('AuthModePassword'), true, 'THE BUG BOTH SIBLINGS HAVE');
  assert.equal(redactor.isSensitiveKey('tokenEndpoint'), false);
  assert.equal(redactor.isSensitiveKey('tokenEndpointSecret'), true);
});

test("key names: a page object's password-field LOCATOR survives", () => {
  // Without this, the agent cannot repair the very thing it was asked to look at.
  const source = "export const PASSWORD_FIELD = By.id('txtPassword');";
  assert.equal(redactor.redact(source), source);
  assert.equal(redactor.isSensitiveKey('PASSWORD_FIELD'), false);
  assert.equal(redactor.isSensitiveKey('passwordInput'), false);
});

test('normaliseKey strips the separators a JS, JSON or .env key might use', () => {
  assert.equal(normaliseKey('DB_PASSWORD'), 'dbpassword');
  assert.equal(normaliseKey('api-key'), 'apikey');
  assert.equal(normaliseKey('auth.token'), 'authtoken');
});

test('values: a redacted value keeps a LENGTH HINT', () => {
  // "The password is empty" is a real diagnosis. The hint lets an agent reason
  // about whether a value was PRESENT without learning what it was.
  assert.equal(redactor.redactValue('apiKey', 'abc123'), `${REDACTION_MARKER} (length=6)`);
  assert.equal(redactor.redactValue('baseUrl', 'https://example.test'), 'https://example.test');
  assert.equal(redactor.redactValue('apiKey', ''), '');
  assert.equal(redactor.redactValue('apiKey', null), '');
});

test('shapes: the JavaScript-specific credentials, which neither sibling has', () => {
  const cases = [
    ['//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz012345', 'npm_abcdefghijk'],
    ['//npm.internal.example.test/:_password=Winter2026!', 'Winter2026'],
    ['const PASSWORD = "Winter2026!";', 'Winter2026'],
    ["const apiKey = 'abc123xyz789';", 'abc123xyz789'],
    ['const headers = { authorization: `Bearer abcdef0123456789ABCDEF` };', 'abcdef0123456789'],
    ['{ "clientSecret": "Winter2026!" }', 'Winter2026'],
    ['DB_PASSWORD=hunter2', 'hunter2'],
    ['export API_KEY=abc123xyz', 'abc123xyz'],
  ];
  for (const [input, secret] of cases) {
    const output = redactor.redact(input);
    assert.equal(output.includes(secret), false, input);
    assert.ok(output.includes(REDACTION_MARKER), input);
  }
});

test('shapes: the cross-ecosystem credentials', () => {
  const url = redactor.redact('baseUrl: "https://svc:Tr0ub4dor@uat.example.com/api"');
  assert.equal(url.includes('Tr0ub4dor'), false);
  assert.ok(url.includes('uat.example.com'), 'the host survives, because it is a real diagnostic');
  assert.ok(url.includes('svc:'), 'so does the user name');

  const conn = redactor.redact('Server=db;User Id=admin;Password=hunter2;');
  assert.equal(conn.includes('hunter2'), false);
  assert.equal(conn.includes('admin'), false);

  const jwt = redactor.redact(
    'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  );
  assert.equal(jwt.includes('eyJhbGciOiJIUzI1NiJ9'), false);

  const pem = redactor.redact(
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890\nabcdefghijklmnop\n-----END RSA PRIVATE KEY-----',
  );
  assert.equal(pem.includes('MIIEowIBAAKCAQEA'), false);
});

test('shapes: a connection-string pattern does NOT sabotage a JavaScript assignment', () => {
  // Regression. The value pattern used to match the single space before a quote,
  // replace it, and leave the real secret in place - AND the inserted marker then
  // stopped the key-aware pattern from matching the assignment at all. A
  // redaction that fires and redacts nothing is worse than one that does not
  // fire, because it looks like it worked.
  const output = redactor.redact('const PASSWORD = "Winter2026!";');
  assert.equal(output, `const PASSWORD = "${REDACTION_MARKER}";`);
});

test('an operator can add key fragments', () => {
  const custom = new SecretRedactor(['tenant_pin']);
  assert.equal(custom.isSensitiveKey('tenantPin'), true);
  assert.equal(redactor.isSensitiveKey('tenantPin'), false);
});

test('empty and absent input are handled', () => {
  for (const value of [null, undefined, '']) assert.equal(redactor.redact(value), '');
});

test('the null redactor changes nothing, and says nothing is sensitive', () => {
  const none = new NullSecretRedactor();
  assert.equal(none.redact('const PASSWORD = "x";'), 'const PASSWORD = "x";');
  assert.equal(none.redactValue('apiKey', 'x'), 'x');
  assert.equal(none.isSensitiveKey('password'), false);
});

test('input longer than the cap is truncated, and SAYS SO', () => {
  const output = redactor.redact('a'.repeat(MAX_REDACTION_INPUT + 5_000));
  assert.ok(output.includes('input truncated'));
  assert.ok(output.length <= MAX_REDACTION_INPUT + 200);
});

/**
 * BOUNDED WORK.
 *
 * These assert a WALL CLOCK, and in JavaScript that is not fussiness. There is
 * no regex timeout, no way to interrupt a match, and a runaway match blocks the
 * single event loop - so the server stops answering everything, including the
 * client's cancellation. The Python sibling found a pattern here that took 23
 * seconds on 250 KB. In Python that was a slow test; here it would be a hung
 * server.
 */
test('bounded work: an unterminated PEM block cannot cause a quadratic scan', () => {
  const hostile = `${'-----BEGIN RSA PRIVATE KEY-----'}${'A'.repeat(50_000)}`.repeat(5);
  const started = performance.now();
  redactor.redact(hostile);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2_000, `took ${Math.round(elapsed)}ms`);
});

test('bounded work: a long run after a BEGIN marker stays linear', () => {
  const hostile = `-----BEGIN PRIVATE KEY-----${'B'.repeat(200_000)}`;
  const started = performance.now();
  redactor.redact(hostile);
  assert.ok(performance.now() - started < 1_000);
});

test('bounded work: a quarter-megabyte of ordinary text stays linear', () => {
  const started = performance.now();
  redactor.redact('a'.repeat(250_000));
  assert.ok(performance.now() - started < 1_000);
});

test('bounded work: many long identifier assignments stay linear', () => {
  // The shape that broke the Python sibling: a long identifier before a
  // delimiter, where an ambiguous pattern can split at every position.
  const hostile = `${'k'.repeat(300)}=v\n`.repeat(1_000);
  const started = performance.now();
  redactor.redact(hostile);
  assert.ok(performance.now() - started < 1_000);
});

test('a credential passed as a COMMAND-LINE FLAG is redacted', () => {
  // Found by the end-to-end MCP test, not by review. `package.json` script
  // values are shell command lines and discovery publishes a manifest excerpt,
  // so this is a real path from a project file to an agent transcript.
  for (const [input, survivor] of [
    ['curl -u admin:Winter2026! https://ci.example.test', 'Winter2026!'],
    ['curl --user ci-bot:hunter2 https://ci.example.test', 'hunter2'],
    ['deploy --token ghp_SyntheticValue000000000000000000', 'ghp_Synthetic'],
    ['cli --password=Winter2026! --verbose', 'Winter2026!'],
    ['tool --api-key abcdef123456', 'abcdef123456'],
    ['tool --access-key=AKIASYNTHETICVALUE00', 'AKIASYNTHETIC'],
  ]) {
    const redacted = redactor.redact(input);
    assert.equal(redacted.includes(survivor), false, input);
    assert.ok(redacted.includes(REDACTION_MARKER), input);
  }
});

test('the flag rule does NOT mangle ordinary commands', () => {
  // A redactor that breaks `mkdir -p dist` teaches an operator to switch it off,
  // which is why `-p` is deliberately not in the flag set and `-u` is matched
  // only in the `user:secret` pair form.
  for (const harmless of [
    'mkdir -p dist && node build.js',
    'mocha --reporter spec "test/**/*.test.js"',
    'rm -rf coverage',
    'docker run -u 1000:1000 node:22',
  ]) {
    if (harmless.startsWith('docker')) continue; // a uid pair IS the pair shape; see below
    assert.equal(redactor.redact(harmless), harmless, harmless);
  }
});

test('the flag rule is honest about what it cannot distinguish', () => {
  // `-u 1000:1000` is indistinguishable from `-u user:secret` without knowing
  // the command, so it IS redacted. Recording that here rather than leaving a
  // future reader to discover it: over-redacting a uid is the correct trade
  // against under-redacting a password, and the alternative is a command
  // allow-list this product has no business maintaining.
  assert.ok(redactor.redact('docker run -u 1000:1000 node:22').includes(REDACTION_MARKER));
});
