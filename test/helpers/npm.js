/**
 * How a test invokes npm, on whichever platform the test is running on.
 *
 * WHY THIS FILE EXISTS. Two tests shell out to npm to assert things nothing else
 * can see: the size of the production dependency tree, and the contents of the
 * published tarball. Both passed on Linux and both failed on Windows with
 * `spawnSync npm ENOENT`, which was a defect in the TESTS, not in the product.
 *
 * WINDOWS NEEDS A DIFFERENT CALL, AND THE REASON IS TWO STACKED FACTS.
 *
 *  1. There is no `npm` executable on Windows. npm ships as `npm.cmd`, a batch
 *     script, so spawning the bare name finds nothing and reports ENOENT.
 *
 *  2. Since the fix for CVE-2024-27980 (Node 18.20.2 / 20.12.2 / 21.7.3 and
 *     everything after, which is this product's entire supported range), spawning
 *     a `.cmd` or `.bat` WITHOUT a shell is refused outright with EINVAL. So
 *     naming `npm.cmd` in `execFileSync` trades one error for another: Windows
 *     requires a shell here, and requires it BECAUSE of a security fix rather
 *     than in spite of one.
 *
 * WHY `execSync` AND NOT `execFileSync({ shell: true })`. The first version of
 * this helper did the latter, and it worked - while printing this on every run:
 *
 *     [DEP0190] DeprecationWarning: Passing args to a child process with shell
 *     option true can lead to security vulnerabilities, as the arguments are not
 *     escaped, only concatenated.
 *
 * Node is right, and the honest response is to stop pretending there is an
 * argument array. When a shell is involved there is only ever a command STRING,
 * so this helper builds one deliberately and asserts it is safe to build, rather
 * than handing Node an array it will silently flatten. POSIX keeps the real
 * argument array and never sees a shell at all.
 *
 * THE ARGUMENT GUARD IS NOT DECORATION. Every argument these tests pass is a
 * literal written in a test source file - `ls`, `--omit=dev`, `--all`, `--json`,
 * `pack`, `--dry-run` - and nothing an agent, a project, a filesystem or an
 * environment variable supplies ever reaches it. `assertShellSafe` is what keeps
 * that true for the next person as well as this one: the moment somebody
 * interpolates a path or a version into an argument, the test fails loudly
 * instead of concatenating it into a shell.
 *
 * The product's own process boundary (phase 1D) uses an argument ARRAY with no
 * shell, and this exemption for test infrastructure does not relax that rule by
 * a single character.
 */

import { execFileSync, execSync } from 'node:child_process';

const WINDOWS = process.platform === 'win32';

/**
 * Characters that mean something to `cmd.exe` or to a POSIX shell, plus
 * whitespace. Deliberately a deny-list of shell syntax rather than an allow-list
 * of "looks fine", because the question being asked is precisely "could a shell
 * read this as anything other than one literal word".
 */
const SHELL_SIGNIFICANT = /[\s"'`^&|<>()[\]{}$;!*?~#\\]/;

/**
 * @param {string} argument
 * @returns {string} the same argument, once it is proven to need no quoting
 */
function assertShellSafe(argument) {
  if (typeof argument !== 'string' || argument.length === 0) {
    throw new TypeError('An npm argument must be a non-empty string literal.');
  }
  if (SHELL_SIGNIFICANT.test(argument)) {
    throw new Error(
      `Refusing to build a shell command from '${argument}': it contains shell-significant ` +
        'characters. Test arguments to npm are literals by design. If a real value now has ' +
        'to be passed, do not quote it here - find a way to assert it that does not need a shell.',
    );
  }
  return argument;
}

/**
 * Run npm and return its stdout.
 *
 * @param {ReadonlyArray<string>} args Literal arguments, e.g. `['pack', '--dry-run', '--json']`.
 * @param {object} [options] Passed through to the child process (`cwd`, `encoding`, `maxBuffer`).
 * @returns {string}
 */
export function runNpm(args, options = {}) {
  const safe = args.map(assertShellSafe);

  if (!WINDOWS) {
    // The good case: a real argument vector, no shell, nothing to escape.
    return execFileSync('npm', safe, options);
  }

  // Windows: one command string, so there is no args-plus-shell combination for
  // Node to warn about and no invisible concatenation step.
  return execSync(['npm', ...safe].join(' '), options);
}
