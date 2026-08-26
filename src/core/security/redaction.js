/**
 * Removing credentials from anything GenXEvo is about to show a model or write
 * to disk.
 *
 * Once a secret enters a model's context it has left the operator's control — it
 * is in a transcript, possibly in a provider's logs, possibly in a report
 * committed to a repository. Redaction therefore happens at the server, before
 * the value is ever placed in a result.
 *
 * The policy deliberately errs towards OVER-redaction. A false positive costs
 * the agent one clarifying question; a false negative leaks a credential.
 * Redacted values keep their key and a length hint, so an agent can still reason
 * about whether a value was PRESENT without learning what it was.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY EVERY QUANTIFIER BELOW IS BOUNDED, AND WHY THAT IS NOT OPTIONAL HERE
 * ────────────────────────────────────────────────────────────────────────────
 * .NET's `Regex` accepts a match timeout. Java has none, but at least has a
 * thread that can be starved. JAVASCRIPT HAS NEITHER: there is no regex timeout,
 * no way to interrupt a match, and a runaway match blocks the single event loop
 * — so the server stops answering everything, including the client's
 * cancellation. `AbortSignal` cannot help, because a signal is only observed
 * between turns of the loop and a regex match is one turn.
 *
 * The Python sibling found this the hard way: an unbounded `[a-zA-Z0-9+.\-]*`
 * before a literal `://` re-scanned from every start position and took 23
 * seconds on 250 KB of ordinary text. In Python that was a slow test. Here it
 * would be a hung server.
 *
 * So: every quantifier is bounded; key-aware patterns match a WHOLE IDENTIFIER
 * and let code decide sensitivity (which is also more correct, because deciding
 * in code reuses the exemption list); the one pattern that must span arbitrary
 * text is guarded by a literal substring check; and input is capped before any
 * pattern runs. `test/security-redaction.test.js` asserts all of it against a
 * WALL CLOCK.
 */

/** Substituted in place of any redacted value. */
export const REDACTION_MARKER = '[genxevo:redacted]';

/** Largest input redaction will scan (1 MiB). Anything longer is truncated with a marker. */
export const MAX_REDACTION_INPUT = 1_048_576;

const KEY_FRAGMENTS = Object.freeze([
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'accesskey',
  'privatekey',
  'clientsecret',
  'connectionstring',
  'authorization',
  'credential',
  'authtoken',
  'basicauth',
  'bearer',
  'sessionid',
  'cookie',
  'signature',
  'passphrase',
  'sastoken',
  'sasurl',
  'npmauthtoken',
  'authtokenvalue',
]);

/**
 * Key names that contain a sensitive fragment but are not themselves secret.
 *
 * Without these, a page object's locator for the password field is redacted and
 * the agent cannot repair the very thing it was asked to look at.
 *
 * MATCHED AS A WHOLE NORMALISED IDENTIFIER, not as a substring, and that is a
 * deliberate correction to both siblings. They test
 * `normalised.includes(exemption)` and short-circuit, so a key named
 * `AuthModePassword` contains `authmode`, is declared non-sensitive, and its
 * value is emitted verbatim. Here `authmodepassword !== authmode`, so it is
 * redacted — and `passwordfieldlocator === passwordfieldlocator`, so the
 * locator still survives.
 */
const EXEMPT_KEYS = Object.freeze(
  new Set([
    'passwordfield',
    'passwordfieldlocator',
    'passwordinput',
    'passwordselector',
    'passwordbox',
    'passwordlocator',
    'passwordlabel',
    'usetokenauth',
    'authmode',
    'authtype',
    'authenticationtype',
    'tokenendpoint',
    'tokenurl',
    'secretname',
    'secretref',
    'keyvaultname',
    'cookiebanner',
    'cookieconsent',
    'cookiename',
    'cookiebutton',
  ]),
);

// Bounded identifier shapes. 64 characters is longer than any real key name and
// short enough that no quantifier can be the source of a quadratic scan.
const IDENT = '[A-Za-z_$][A-Za-z0-9_$]{0,63}';
const QUOTED_KEY = '[A-Za-z_$][A-Za-z0-9_$.\\-]{0,63}';
const VALUE = '{0,4096}';

/**
 * Key-aware patterns.
 *
 * Each captures a `pre` group covering everything up to the value and a `key`
 * group, so the replacement is simply `pre + MARKER` and no pattern needs
 * bespoke reassembly. The FRAGMENTS ARE NOT EMBEDDED IN THE EXPRESSION: an
 * alternation like `[A-Za-z0-9_]*(?:password|secret|…)[A-Za-z0-9_]*` is
 * ambiguous — the engine can split a long identifier at every position — and a
 * non-matching input of a few hundred thousand characters backtracks
 * catastrophically.
 */
const KEY_AWARE_PATTERNS = Object.freeze([
  // { "clientSecret": "…" } — JSON, and a quoted key in an object literal.
  new RegExp(
    `(?<pre>"(?<key>${QUOTED_KEY})"[ \\t]{0,8}:[ \\t]{0,8}")(?<value>[^"\\r\\n]${VALUE})(?=")`,
    'g',
  ),
  new RegExp(
    `(?<pre>'(?<key>${QUOTED_KEY})'[ \\t]{0,8}:[ \\t]{0,8}')(?<value>[^'\\r\\n]${VALUE})(?=')`,
    'g',
  ),
  // const PASSWORD = "…" / { password: '…' } — how a credential actually appears
  // in a JavaScript automation project, in a config or a fixture.
  new RegExp(
    `(?<pre>\\b(?<key>${IDENT})[ \\t]{0,8}[:=][ \\t]{0,8}")(?<value>[^"\\r\\n]${VALUE})(?=")`,
    'g',
  ),
  new RegExp(
    `(?<pre>\\b(?<key>${IDENT})[ \\t]{0,8}[:=][ \\t]{0,8}')(?<value>[^'\\r\\n]${VALUE})(?=')`,
    'g',
  ),
  // password: `…` — a template literal, which is idiomatic JavaScript and has no
  // analogue in either sibling's pattern set.
  new RegExp(
    `(?<pre>\\b(?<key>${IDENT})[ \\t]{0,8}[:=][ \\t]{0,8}\`)(?<value>[^\`\\r\\n]${VALUE})(?=\`)`,
    'g',
  ),
  // API_KEY=abc123 — a .env file, unquoted.
  new RegExp(
    `(?<pre>^[ \\t]{0,16}(?:export[ \\t]{1,4})?(?<key>${IDENT})[ \\t]{0,8}=[ \\t]{0,8})(?<value>[^\\r\\n#]{1,4096})`,
    'gm',
  ),
]);

/**
 * Value-shape patterns, applied to every input regardless of any key name.
 * Every quantifier is bounded; see the module note.
 */
const VALUE_PATTERNS = Object.freeze([
  // .npmrc registry auth. THE highest-value JavaScript shape, and neither
  // sibling has an analogue: `//registry.npmjs.org/:_authToken=npm_xxx`.
  [
    /(?<pre>^[ \t]{0,8}\/\/[^\s:]{1,256}:(?:_authToken|_auth|_password|username|email)[ \t]{0,4}=[ \t]{0,4})(?<value>\S{1,4096})/gim,
    `$<pre>${REDACTION_MARKER}`,
  ],
  // Connection-string style key=value pairs.
  //
  // The value must begin with a NON-SPACE, NON-QUOTE character, and that is
  // load-bearing rather than tidy. Without it, `const PASSWORD = "hunter2";`
  // matches with the value captured as the single space before the quote: the
  // pattern then replaces the space, leaves the real secret in place, and — the
  // worse half — the inserted marker stops the key-aware pattern below from
  // matching the assignment at all. A redaction that fires and redacts nothing
  // is worse than one that does not fire, because it looks like it worked.
  [
    /(?<pre>\b(?:password|pwd|user id|uid|account key|shared access key)[ \t]{0,4}=[ \t]{0,4})(?<value>[^\s;"'`\r\n][^;"'`\r\n]{0,511})/gi,
    `$<pre>${REDACTION_MARKER}`,
  ],
  // Credentials embedded in a URL. The scheme cap is load-bearing, not tidy.
  [
    /(?<scheme>[a-zA-Z][a-zA-Z0-9+.\-]{0,20}:\/\/)(?<user>[^:/@\s]{1,256}):(?<pw>[^@/\s]{1,256})@/g,
    `$<scheme>$<user>:${REDACTION_MARKER}@`,
  ],
  // A CREDENTIAL PASSED AS A COMMAND-LINE FLAG.
  //
  // Neither sibling has an analogue and neither needs one. This product does:
  // `package.json` SCRIPT VALUES ARE SHELL COMMAND LINES, and discovery
  // publishes a manifest excerpt as untrusted evidence, so
  // `"deploy": "curl -u admin:hunter2 https://ci.example.test"` is a real path
  // from a project file to an agent transcript. It was found by the end-to-end
  // MCP test rather than by review, which is the argument for having one.
  //
  // `-u` is matched ONLY in the `user:secret` pair form, and `-p` is not matched
  // at all: `mkdir -p dist` is a far more common script body than a MySQL
  // password, and a redactor that mangles ordinary commands teaches an operator
  // to switch it off.
  [
    /(?<pre>(?:^|[\s"'`])--?(?:u|user)[ \t=](?<user>[^\s:"'`]{1,128}):)(?<secret>[^\s"'`]{1,512})/g,
    `$<pre>${REDACTION_MARKER}`,
  ],
  [
    /(?<pre>(?:^|[\s"'`])--(?:password|pass|token|api-?key|auth-?token|access-?key|secret)[ \t=])(?<value>[^\s"'`]{1,512})/gi,
    `$<pre>${REDACTION_MARKER}`,
  ],
  // Authorization headers.
  [
    /(?<prefix>\b(?:bearer|basic)[ \t]{1,4})(?<value>[A-Za-z0-9\-._~+/=]{8,4096})/gi,
    `$<prefix>${REDACTION_MARKER}`,
  ],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]{5,4096}\.[A-Za-z0-9_-]{5,4096}\.[A-Za-z0-9_-]{5,4096}/g, REDACTION_MARKER],
  // npm automation tokens have a fixed, recognisable prefix.
  [/\bnpm_[A-Za-z0-9]{30,64}\b/g, REDACTION_MARKER],
]);

const PEM_PATTERN =
  /-----BEGIN[^-]{0,64}PRIVATE KEY-----[\s\S]{0,1048576}?-----END[^-]{0,64}PRIVATE KEY-----/gi;

/**
 * Reduce a key name to the form the exemption set and the fragment list are
 * written in: lowercase, with the separators a JavaScript, JSON or .env key
 * might use removed.
 *
 * @param {string} key
 * @returns {string}
 */
export function normaliseKey(key) {
  return String(key)
    .toLowerCase()
    .replace(/[_\-.\s]/g, '');
}

/** The default redaction policy: key-name detection plus value-shape detection. */
export class SecretRedactor {
  #fragments;

  /** @param {Iterable<string>} [additionalKeyFragments] From the operator's configuration. */
  constructor(additionalKeyFragments = []) {
    const fragments = [...KEY_FRAGMENTS];
    for (const fragment of additionalKeyFragments ?? []) {
      const normalised = normaliseKey(fragment);
      if (normalised && !fragments.includes(normalised)) fragments.push(normalised);
    }
    this.#fragments = Object.freeze(fragments);
  }

  /**
   * True when a key name indicates a sensitive value.
   *
   * The exemption is checked as an EXACT normalised match, so a key that merely
   * begins with an exempt word is still redacted.
   *
   * @param {string} key
   * @returns {boolean}
   */
  isSensitiveKey(key) {
    if (typeof key !== 'string' || key.trim().length === 0) return false;
    const normalised = normaliseKey(key);
    if (EXEMPT_KEYS.has(normalised)) return false;
    return this.#fragments.some((fragment) => normalised.includes(fragment));
  }

  /**
   * Redact a configuration value, using the key name as the primary signal.
   *
   * Key-name matching is far more reliable than value-shape matching for
   * configuration: `password = admin` is obviously a secret and `admin` on its
   * own obviously is not.
   *
   * @param {string} key
   * @param {string | null | undefined} value
   * @returns {string}
   */
  redactValue(key, value) {
    if (value === null || value === undefined || value === '') return '';
    if (this.isSensitiveKey(key)) {
      // The length hint lets an agent reason about whether a value was present —
      // "the password is empty" is a real diagnosis — without learning anything
      // about what it was.
      return `${REDACTION_MARKER} (length=${String(value).length})`;
    }
    return this.redact(String(value));
  }

  /**
   * Redact secret-looking values found anywhere in free text.
   *
   * @param {string | null | undefined} text
   * @returns {string}
   */
  redact(text) {
    if (text === null || text === undefined || text === '') return '';

    let result = String(text);
    let truncated = false;
    if (result.length > MAX_REDACTION_INPUT) {
      result = result.slice(0, MAX_REDACTION_INPUT);
      truncated = true;
    }

    // Guarded by a literal substring check, because an unterminated BEGIN block
    // would otherwise make the engine scan to the end of the input from every
    // start position.
    if (result.includes('-----BEGIN') && result.includes('-----END')) {
      result = result.replace(PEM_PATTERN, REDACTION_MARKER);
    }

    // Key-aware patterns run FIRST, deliberately. They are gated on a key name
    // and are therefore the more precise of the two families; running the
    // value-shape patterns first lets a loose match insert a marker in the
    // middle of an assignment and prevent the precise pattern from ever seeing
    // it. Both siblings run them the other way round.
    for (const pattern of KEY_AWARE_PATTERNS) {
      pattern.lastIndex = 0;
      result = result.replace(pattern, (...args) => {
        const groups = args.at(-1);
        if (!this.isSensitiveKey(groups.key)) return args[0];
        return groups.pre + REDACTION_MARKER;
      });
    }

    // Value-shape patterns are the backstop: they fire wherever a credential is
    // recognisable without any key name at all.
    for (const [pattern, replacement] of VALUE_PATTERNS) {
      pattern.lastIndex = 0;
      result = result.replace(pattern, replacement);
    }

    if (truncated) {
      result += `\n${REDACTION_MARKER} (input truncated at ${MAX_REDACTION_INPUT} characters)`;
    }
    return result;
  }
}

/**
 * A redactor that does nothing.
 *
 * For tests and for operators who explicitly disable redaction. That choice is
 * reported as an advisory configuration issue on every start and in every
 * `genxevo_agent_status` call — it is a legitimate decision an operator should
 * be reminded of, not a silent one.
 */
export class NullSecretRedactor {
  redact(text) {
    return text ?? '';
  }
  redactValue(_key, value) {
    return value ?? '';
  }
  isSensitiveKey() {
    return false;
  }
}
